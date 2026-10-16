/**
 * 分析管线：把"一个目录"变成"一张图 + 一份坐标"。
 *
 * 单独成模块而不是塞进 CLI，是为了让测试能直接调用它，
 * 不必 spawn 子进程、不必解析终端输出。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Log } from './log.mjs';
import { scan } from './scan.mjs';
import { parseImports } from './imports.mjs';
import { buildIndex, loadTsconfig, resolveRef } from './resolve.mjs';
import { importsMapOf } from './pkg-imports.mjs';
import { buildGraph } from './graph.mjs';
import { layout } from './layout.mjs';

/**
 * @typedef {object} AnalyzeOptions
 * @property {string[]} [languages]      仅分析这些语言（js/ts/py/generic）
 * @property {boolean} [includeTests]
 * @property {boolean} [groupDir]        强制按目录聚合
 * @property {number} [groupDepth]
 * @property {number} [maxNodes]
 * @property {number} [maxFiles]
 * @property {string[]} [ignore]
 * @property {boolean} [strict]
 * @property {Log} [log]
 */

/**
 * @param {string} root
 * @param {AnalyzeOptions} [opts]
 */
export async function analyze(root, opts = {}) {
  const log = opts.log || new Log();
  const startedAt = Date.now();

  // 1) 扫描
  const scanned = await scan(root, {
    log,
    ignore: opts.ignore,
    testPatterns: opts.includeTests ? [] : undefined,
    limits: opts.maxFiles ? { maxFiles: opts.maxFiles } : undefined,
  });

  let files = scanned.files;
  if (opts.languages && opts.languages.length > 0) {
    const allow = new Set(opts.languages);
    files = files.filter((f) => allow.has(f.language));
  }

  // 2) 解析依赖
  //
  // tsconfig 按"离文件最近的"来选，而不是只看仓库根。
  // monorepo 里每个包有各自的路径别名，用错配置会把 @core/config
  // 解析成外部包，图就变成一堆假依赖。
  const tsconfigCache = new Map();
  // loadTsconfig 内部还有一层"按绝对路径缓存已解析配置"的 map，
  // 传进去可以让多个包的 tsconfig 共享同一份基配置，避免重复读盘与重复跟随 extends。
  const resolvedConfigCache = new Map();
  // 单独记录"哪些目录真的查过了"。
  // 不能直接用 tsconfigCache.has(root) 判断，否则仓库根那一项会让所有
  // 查找在第一次循环就返回根配置，包里自己的 tsconfig 永远读不到。
  const tsconfigLoaded = new Set();
  const baseTsconfig = await loadTsconfig(scanned.root, log, '', resolvedConfigCache);
  tsconfigCache.set('', baseTsconfig);
  tsconfigLoaded.add('');

  const tsconfigFor = async (relPath) => {
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const parts = dir ? dir.split('/') : [];
    for (let up = 0; up <= parts.length; up += 1) {
      const root = parts.slice(0, parts.length - up).join('/');
      if (!tsconfigLoaded.has(root)) {
        const cfg = await loadTsconfig(join(scanned.root, root), null, root, resolvedConfigCache);
        tsconfigCache.set(root, cfg);
        tsconfigLoaded.add(root);
      }
      const cfg = tsconfigCache.get(root);
      if (cfg) return cfg;
    }
    return null;
  };

  const index = buildIndex(files);
  const languageOf = new Map(files.map((f) => [f.path, f.language]));

  // package.json 的 imports 映射（# 别名），按"离文件最近的、定义了 imports 的
  // package.json"取——所以要逐级向上找，不能只看同目录。
  // 找不到时把该目录标记为 null，避免对同一目录反复读盘。
  const pkgCache = new Map();
  const pkgImportsFor = async (relPath) => {
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const parts = dir ? dir.split('/') : [];
    for (let up = 0; up <= parts.length; up += 1) {
      const at = parts.slice(0, parts.length - up).join('/');
      if (pkgCache.has(at)) {
        const hit = pkgCache.get(at);
        if (hit) return hit;
        continue; // 该层没有 imports，继续往上找
      }
      let found = null;
      try {
        const json = JSON.parse(await readFile(join(scanned.root, at, 'package.json'), 'utf8'));
        const imports = importsMapOf(json);
        if (imports) found = { dir: at, imports };
      } catch {
        found = null;
      }
      pkgCache.set(at, found);
      if (found) return found;
    }
    return null;
  };

  /** @type {Array<import('./resolve.mjs').Resolved>} */
  const resolved = [];
  /** @type {Set<string>} */
  const unresolvedSeen = new Set();

  for (const file of files) {
    let text;
    try {
      text = await readFile(join(scanned.root, file.path), 'utf8');
    } catch (err) {
      log.warn('read-failed', `无法读取文件: ${err.message}`, { file: file.path });
      continue;
    }

    const refs = parseImports(file.path, file.language, text);
    const tsconfig = languageOf.get(file.path) === 'py' ? null : await tsconfigFor(file.path);
    const packageImports = languageOf.get(file.path) === 'py' ? null : await pkgImportsFor(file.path);
    for (const raw of refs) {
      for (const ref of expandRef(raw)) {
        const r = resolveRef(ref, {
          index,
          tsconfig,
          packageImports,
          languageOf: (p) => languageOf.get(p) || null,
          isWorkspaceDep: () => false,
        });
        if (r.kind === 'unresolved') {
          const key = `${r.from}|${r.specifier}`;
          if (!unresolvedSeen.has(key)) {
            unresolvedSeen.add(key);
            log.warn('unresolved-import', `无法解析导入 "${r.specifier}"`, {
              file: r.from,
              line: r.line,
            });
          }
          continue;
        }
        // 标准库与系统头文件不算架构依赖，直接丢弃，不进图也不报警告
        if (r.kind === 'stdlib' || r.importKind === 'system-include') continue;
        resolved.push(r);
      }
    }
  }

  resolved.sort((a, b) =>
    a.from === b.from ? (a.line === b.line ? (a.specifier < b.specifier ? -1 : 1) : a.line - b.line) : a.from < b.from ? -1 : 1,
  );

  // 3) 建图（必要时上卷到目录级）
  //
  // 自指边必须一路留到建图阶段：它是"文件引用自己"的唯一证据，
  // 提前丢掉会让自环彻底不可见。建图内部会保证它只影响 cycles、
  // 不进入最终边表。
  const maxNodes = opts.maxNodes ?? 400;
  let groupDir = Boolean(opts.groupDir);
  let groupDepth = opts.groupDepth ?? 2;

  let graph = buildGraph({ files, resolved }, { groupDir, groupDepth });

  if (!groupDir && graph.stats.nodeCount > maxNodes) {
    let depth = 2;
    let attempt = buildGraph({ files, resolved }, { groupDir: true, groupDepth: depth });
    // 逐级上卷，直到落到上限以内或到顶
    while (attempt.stats.nodeCount > maxNodes && depth > 1) {
      depth -= 1;
      attempt = buildGraph({ files, resolved }, { groupDir: true, groupDepth: depth });
    }
    log.warn(
      'auto-grouped',
      `模块数 ${graph.stats.nodeCount} 超过上限 ${maxNodes}，已按目录（深度 ${depth}）聚合`,
    );
    graph = attempt;
    groupDir = true;
    groupDepth = depth;
  }

  // 4) 布局
  const laid = layout(graph);

  return {
    root: scanned.root,
    files,
    resolved,
    graph,
    layout: laid,
    tsconfig: baseTsconfig,
    tsconfigs: [...tsconfigCache.entries()]
      .filter(([, cfg]) => cfg)
      .map(([dir, cfg]) => ({ dir: dir || '.', file: cfg.file })),
    diagnostics: log.diagnostics,
    extras: {
      fileCount: files.length,
      scanned: scanned.stats,
      durationMs: Date.now() - startedAt,
      unresolved: unresolvedSeen.size,
    },
  };
}

/**
 * 一条 import 语句可能引出多个模块：
 *   import a, b          (Python)
 *   from x import a, b   (Python)
 * 需要先摊平成"一条引用 = 一个 specifier"。
 *
 * @param {import('./imports.mjs').ImportRef} ref
 */
export function expandRef(ref) {
  if (ref.kind === 'import' && ref.specifier.includes(',')) {
    return ref.specifier
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ ...ref, specifier: stripAs(s) }));
  }
  return [ref];
}

function stripAs(s) {
  return s.split(/\s+as\s+/)[0].trim();
}
