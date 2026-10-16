/**
 * 把"引用了哪个模块"解析成图里的边。
 *
 * 解析优先级（命中即停）：
 *   1. 相对路径（./ ../ 或 Python 的 . 前缀）
 *   2. tsconfig / jsconfig 的 baseUrl + paths 别名（含 extends 继承）
 *   3. Python 的裸导入（按 sys.path 语义在仓库内查找）
 *   4. 裸标识符 → 外部包（标准库与 Node 内置模块会被识别并过滤掉）
 *   5. 解析失败 → 诊断（--strict 时升级为错误）
 *
 * 全部基于扫描阶段建好的"本地模块索引"，不在解析过程中遍历磁盘，
 * 因此结果与目录遍历顺序无关，可重复、可测试。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { supportsBareSpecifier } from './lang.mjs';
import { isPythonStdlib } from './py-stdlib.mjs';
import { isNodeBuiltin } from './node-builtins.mjs';
import { isPackageImportsSpecifier, resolvePackageImports } from './pkg-imports.mjs';

/** 按语言给出补全后缀的候选顺序 */
const EXT_CANDIDATES = {
  js: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
  ts: ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs'],
  py: ['.py', '.pyi'],
  generic: ['.h', '.hpp', '.hh', '.c', '.cpp', '.cc', '.cxx'],
};

const INDEX_CANDIDATES = {
  js: ['index.js', 'index.mjs', 'index.cjs', 'index.jsx', 'index.ts', 'index.tsx'],
  ts: ['index.ts', 'index.tsx', 'index.mts', 'index.cts', 'index.js', 'index.mjs'],
  py: ['__init__.py', '__init__.pyi'],
  generic: [],
};

/**
 * @typedef {object} ModuleIndex
 * @property {Set<string>} files      所有已扫描文件的相对路径
 * @property {Set<string>} dirs       所有已扫描文件所在的目录（含各级父目录）
 * @property {(fromDir: string, target: string) => string | null} normalize
 */

/**
 * 建本地模块索引。
 * @param {import('./scan.mjs').FileInfo[]} files
 */
export function buildIndex(files) {
  const fileSet = new Set();
  const dirSet = new Set(['']);
  for (const f of files) {
    fileSet.add(f.path);
    const parts = f.dir ? f.dir.split('/') : [];
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      dirSet.add(acc);
    }
  }
  return {
    files: fileSet,
    dirs: dirSet,
    normalize: (fromDir, target) => normalizePosix(fromDir ? `${fromDir}/${target}` : target),
  };
}

/** 折叠 . 和 ..，去掉多余斜杠 */
export function normalizePosix(p) {
  const out = [];
  for (const part of String(p).replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dirOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}

// ---------------------------------------------------------------------------
// 解析结果
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Resolved
 * @property {'internal' | 'external' | 'stdlib' | 'unresolved'} kind
 * @property {string} [target]   internal 时的目标文件相对路径
 * @property {string} [pkg]      external / stdlib 时的包名
 * @property {string} specifier
 * @property {string} from      引用方文件
 * @property {number} line
 * @property {string} importKind
 */

/**
 * 判断一个 specifier 是否指向外部包。
 * 返回包名（scoped 包取 @scope/name），否则 null。
 *
 * 相对路径在这里必须返回 null："./x" 的第一段是 "."，
 * 如果直接当成包名，会把"解析失败"伪装成"依赖了一个叫 . 的包"。
 * @param {string} spec
 */
export function packageNameOf(spec) {
  if (!spec) return null;
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  const [first] = spec.split('/');
  return first || null;
}

// ---------------------------------------------------------------------------
// tsconfig / jsconfig
// ---------------------------------------------------------------------------

/**
 * 解析 JSONC：去掉行内/块注释与尾逗号。
 * 不引依赖，因为 tsconfig 的实际写法极其有限。
 * @param {string} text
 */
export function parseJsonc(text) {
  let out = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (c === quote) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  // 去尾逗号
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

/**
 * 读取 tsconfig / jsconfig 的路径映射。找不到或解析失败都返回 null。
 *
 * `dir` 必须一起带出来：`baseUrl: "."` 是相对**配置文件所在目录**，
 * 不是仓库根。不记录它，monorepo 里 packages/a 的别名会被解析到仓库根的
 * src/ 下，于是所有别名依赖都变成假边或解析失败。
 *
 * 支持 `extends`（含链式）：真实项目几乎都靠它把别名放在 base config 里，
 * 不跟随的话所有 `@lib/*` 都会被当成外部包，图直接失真。
 *
 * @param {string} root 本次查找的起点目录（绝对路径）
 * @param {import('./log.mjs').Log} [log]
 * @param {string} [relDir] 该目录相对仓库根的 POSIX 路径
 * @param {Map<string, object|null>} [cache] 跨文件共享的结果缓存
 */
export async function loadTsconfig(root, log, relDir = '', cache) {
  // 只用于"当前这条 extends 链"的环检测。
  // 不能拿它当缓存：同一个配置文件被不同包的 tsconfig 继承是常态。
  const chain = new Set();

  /**
   * @param {string} absDir 配置所在绝对目录
   * @param {string} dir 配置所在相对目录（POSIX）
   * @param {string} fileName
   */
  async function loadOne(absDir, dir, fileName) {
    const chainKey = normalizePosix(`${dir}/${fileName}`);
    const absKey = join(absDir, fileName);
    if (cache && cache.has(absKey)) return cache.get(absKey);
    // 环检测用绝对路径做键。
    // 用相对目录会因 `../..` 被折叠掉而误判：packages/a 的 tsconfig 跟随
    // ../../tsconfig.json 时，两者的相对键会撞成同一个值，
    // 于是"继承根配置"被当成"extends 成环"，别名全部丢失。
    if (chain.has(absKey)) {
      log?.warn('tsconfig-extends-cycle', `extends 出现循环，已停止跟随: ${chainKey}`, {
        file: chainKey,
      });
      return null;
    }
    chain.add(absKey);

    let text;
    try {
      text = await readFile(absKey, 'utf8');
    } catch {
      chain.delete(absKey);
      return null;
    }

    let json;
    try {
      json = parseJsonc(text);
    } catch (err) {
      log?.warn('tsconfig-parse-failed', `${chainKey} 解析失败，已忽略路径别名: ${err.message}`, {
        file: chainKey,
      });
      chain.delete(absKey);
      return null;
    }

    // 先跟随 extends，再把本文件的设置覆盖上去
    let base = null;
    const ext = json.extends;
    if (typeof ext === 'string' && ext) {
      base = await followExtends(absDir, dir, ext);
    }

    const co = json.compilerOptions || {};
    const ownBaseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : null;
    /** @type {Array<{pattern: string, targets: string[]}>} */
    const ownPaths = [];
    if (co.paths && typeof co.paths === 'object') {
      for (const k of Object.keys(co.paths).sort()) {
        const val = co.paths[k];
        if (Array.isArray(val)) ownPaths.push({ pattern: k, targets: val.map(String) });
      }
    }

    // 本文件显式声明就用自己的（含目录归属），否则继承基配置的
    const baseUrl = ownBaseUrl ?? base?.baseUrl ?? '.';
    const paths = ownPaths.length > 0 ? ownPaths : (base?.paths ?? []);
    // paths 来自基配置时，基准目录也必须跟着基配置走
    const dirForPaths = ownPaths.length > 0 ? dir : ownBaseUrl ? dir : (base?.dirForPaths ?? dir);

    if (paths.length > 0 && !ownBaseUrl && !base?.baseUrl) {
      log?.warn('tsconfig-no-baseurl', `${chainKey} 定义了 paths 但没有 baseUrl，按 "./" 处理`, {
        file: chainKey,
      });
    }

    const result = {
      file: fileName,
      dir,
      baseUrl,
      paths,
      dirForPaths,
      source: chainKey,
      inherited: base?.source ?? null,
    };
    chain.delete(absKey);
    if (cache) cache.set(absKey, result);
    return result;
  }

  /**
   * 解析 extends 的写法：相对路径、`./x.json`、或无扩展名的 `./x`。
   * 不处理 npm 包形式的 extends（如 `@tsconfig/node20`）——
   * 那需要读 node_modules，超出本工具的范围；遇到时给一条警告说明未跟随。
   */
  async function followExtends(absDir, dir, spec) {
    if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:/.test(spec)) {
      // 注意：这里不能先 normalizePosix，否则 `../..` 会被折叠掉，
      // 从而把"基配置在两级之上"错算成"基配置在当前目录"。
      const raw = String(spec).replace(/\\/g, '/');
      const slash = raw.lastIndexOf('/');
      const baseDir = slash === -1 ? '' : raw.slice(0, slash);
      const baseName = raw.slice(slash + 1);

      const absBaseDir = baseDir ? join(absDir, ...baseDir.split('/')) : absDir;
      const absRelDir = normalizePosix([dir, baseDir].filter(Boolean).join('/'));
      const candidates = baseName.endsWith('.json') ? [baseName] : [`${baseName}.json`, baseName];

      for (const cand of candidates) {
        const r = await loadOne(absBaseDir, absRelDir, cand);
        if (r) return r;
      }
      log?.warn('tsconfig-extends-missing', `extends 指向的文件不存在: ${spec}`, {
        file: dir || '.',
      });
      return null;
    }
    log?.warn(
      'tsconfig-extends-package',
      `extends 指向 npm 包（${spec}），需要读 node_modules，已跳过跟随；该别名可能解析不出来`,
      { file: dir || '.' },
    );
    return null;
  }

  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = await loadOne(root, relDir, name);
    if (cfg) return cfg;
  }
  return null;
}

/**
 * 用 tsconfig paths 尝试解析别名。
 * @param {string} spec
 * @param {{ dir?: string, dirForPaths?: string, baseUrl: string, paths: Array<{pattern: string, targets: string[]}> }} tsconfig
 * @returns {string[]} 候选相对路径（未补后缀）
 */
export function applyPaths(spec, tsconfig) {
  const candidates = [];
  // baseUrl 相对"定义 paths 的那份配置"所在目录：
  // 别名是继承来的时候，基准是基配置的目录，而不是使用方配置的目录。
  const configDir = tsconfig.dirForPaths ?? tsconfig.dir ?? '';
  const base = normalizePosix(
    [configDir, tsconfig.baseUrl === '.' ? '' : tsconfig.baseUrl].filter(Boolean).join('/'),
  );

  for (const { pattern, targets } of tsconfig.paths) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (spec !== pattern) continue;
      for (const t of targets) candidates.push(normalizePosix(base ? `${base}/${t}` : t));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!spec.startsWith(prefix)) continue;
    if (suffix && !spec.endsWith(suffix)) continue;
    const middle = spec.slice(prefix.length, suffix ? spec.length - suffix.length : undefined);
    for (const t of targets) {
      const filled = t.includes('*') ? t.replace('*', middle) : `${t}${middle}`;
      candidates.push(normalizePosix(base ? `${base}/${filled}` : filled));
    }
  }
  // 兜底：有些项目只配了 baseUrl，裸路径直接相对 baseUrl 解析
  candidates.push(normalizePosix(base ? `${base}/${spec}` : spec));
  return candidates;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/**
 * Python 绝对导入的候选路径。
 *
 * 关键点：`from a.b.c import x` 里的 x 既可能是 a/b/c.py 里的变量，
 * 也可能是子模块 a/b/c/x.py。所以先试完整的 a/b/c/x，再逐级往前退。
 * 顺序很重要——先把更长（更具体）的路径放在前面。
 *
 * @param {string} specifier
 * @returns {string[]}
 */
export function pythonImportCandidates(specifier) {
  const clean = String(specifier).replace(/^\.+/, '');
  if (!clean) return [];
  const parts = clean.replace(/\./g, '/').split('/').filter(Boolean);
  const out = [];
  for (let take = parts.length; take >= 1; take -= 1) {
    out.push(parts.slice(0, take).join('/'));
  }
  return out;
}

/**
 * Python 裸导入（无点号前缀）的本地解析。
 *
 * 从文件所在目录逐级往外试，走到仓库根为止：
 *   - 仓库根：`from app.core.models import X` 这种包内绝对导入
 *   - 当前文件目录：`import polygon_steps` 这种同目录脚本互引
 *
 * 不这样做就会漏掉所有包内绝对导入——而那是 Python 项目最常见的写法。
 * 也不能无限往上走：那样会在 monorepo 里把毫不相干的同名目录连起来。
 *
 * @param {string} relPath
 * @param {string} specifier
 * @param {ModuleIndex} index
 * @returns {string | null}
 */
export function resolvePythonBare(relPath, specifier, index) {
  const candidates = pythonImportCandidates(specifier);
  if (candidates.length === 0) return null;

  const pkgDir = dirOf(relPath);
  const parts = pkgDir ? pkgDir.split('/') : [];

  for (let up = 0; up <= parts.length; up += 1) {
    const rootParts = parts.slice(0, parts.length - up);
    const root = rootParts.join('/');
    const prefixed = candidates.map((c) => normalizePosix(root ? `${root}/${c}` : c));
    const hit = tryCandidates(prefixed, 'py', index);
    if (hit) return hit;
    if (root === '') break;
  }
  return null;
}

/**
 * Python 相对导入（from . import x / from ..pkg import y）。
 *
 * 和绝对导入同理，要把更具体的候选排前面：
 * 对 `.api.routes.build_routes` 应该先试 app/api/routes/build_routes，
 * 再退到 app/api/routes.py，绝不能先命中 app/api/__init__.py——
 * 那会把"引用了 routes 模块"错记成"引用了 api 包"。
 *
 * @param {string} relPath
 * @param {string} specifier
 * @param {ModuleIndex} index
 * @returns {string | null}
 */
export function resolvePythonRelative(relPath, specifier, index) {
  const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  if (dots === 0) return null;
  const rest = specifier.slice(dots);
  const pkgDir = dirOf(relPath);
  const parts = pkgDir ? pkgDir.split('/') : [];
  const up = dots - 1;
  const baseParts = parts.slice(0, Math.max(0, parts.length - up));
  const target = normalizePosix([...baseParts, rest.replace(/\./g, '/')].filter(Boolean).join('/'));

  const candidates = [];
  if (target) {
    const segs = target.split('/');
    for (let take = segs.length; take >= 1; take -= 1) candidates.push(segs.slice(0, take).join('/'));
  } else {
    candidates.push('.');
  }
  return tryCandidates(candidates, 'py', index);
}

// ---------------------------------------------------------------------------
// 主解析入口
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ResolveContext
 * @property {ModuleIndex} index
 * @property {{ baseUrl: string, dir?: string, dirForPaths?: string, paths: Array<{pattern: string, targets: string[]}> } | null} tsconfig
 * @property {{ dir: string, imports: Array<{pattern: string, targets: string[]}> } | null} [packageImports]
 * @property {(path: string) => import('./lang.mjs').Language | null} languageOf
 * @property {(pkg: string) => boolean} isWorkspaceDep
 */

/**
 * @param {import('./imports.mjs').ImportRef} ref
 * @param {ResolveContext} ctx
 * @returns {Resolved}
 */
export function resolveRef(ref, ctx) {
  const { relPath, specifier, line, kind } = ref;
  const language = ctx.languageOf(relPath);
  const fromDir = dirOf(relPath);

  const base = {
    specifier,
    from: relPath,
    line,
    importKind: kind,
  };

  if (!specifier) return { ...base, kind: 'unresolved' };

  // 0) package.json 的 imports 别名（# 开头）必须最先处理：
  //    它长得像"包名"，落到后面的分支就会变成名为 "#utils" 的外部包。
  if (isPackageImportsSpecifier(specifier)) {
    const pkg = ctx.packageImports;
    if (pkg) {
      // 用索引自带的 normalize(dirs, rel)：imports 的目标是相对 package.json
      // 所在目录的，传单参数版本会把两段路径丢掉，候选全变成空串
      const candidates = resolvePackageImports(specifier, pkg.imports, pkg.dir, ctx.index.normalize);
      for (const cand of candidates) {
        const target = tryCandidates([cand], language, ctx.index);
        if (target) return { ...base, kind: 'internal', target };
      }
    }
    // 找不到映射就是坏引用，不能伪装成外部包
    return { ...base, kind: 'unresolved' };
  }

  // 1) 相对路径（JS 的 ./ ../ 与 Python 的 . 前缀是两种语义，分开处理）
  if (specifier.startsWith('.')) {
    const target =
      language === 'py'
        ? resolvePythonRelative(relPath, specifier, ctx.index)
        : tryCandidates([normalizePosix(`${fromDir}/${specifier}`)], language, ctx.index);
    if (target) return { ...base, kind: 'internal', target };
    // 相对路径解析不到就是真的解析不到，不能退化成"外部包"——
    // 否则 "./missing" 会被当成名叫 "." 的包，静默掩盖一个真实的坏引用
    return { ...base, kind: 'unresolved' };
  }

  // Python 的裸导入要当"模块路径"而不是"包名"对待：
  // import polygon_steps 完全可能指向同目录的 polygon_steps.py。
  if (language === 'py') {
    const local = resolvePythonBare(relPath, specifier, ctx.index);
    if (local) return { ...base, kind: 'internal', target: local };
  }

  // 2) tsconfig 别名
  const aliasCandidates =
    ctx.tsconfig && (language === 'js' || language === 'ts')
      ? applyPaths(specifier, ctx.tsconfig)
      : [];

  for (const cand of aliasCandidates) {
    const target = tryCandidates([cand], language, ctx.index);
    if (target) return { ...base, kind: 'internal', target };
  }

  // 3) C/C++ 引号 include：相对当前文件解析，这是 C 标准行为，
  // 也是很多仓库里唯一的真实依赖（同目录 .h/.cpp 互引）
  if (language === 'generic') {
    const target = tryCandidates([normalizePosix(`${fromDir}/${specifier}`)], 'generic', ctx.index);
    if (target) return { ...base, kind: 'internal', target };
    // 找不到就当系统头文件处理，不制造噪音
    return { ...base, kind: 'external', pkg: specifier };
  }

  // 4) 外部包
  if (supportsBareSpecifier(language)) {
    // Python 的点号是模块层级，不是 npm 的 scope：
    // dataclasses.dataclass 的包名是 dataclasses，必须取第一段来判标准库。
    const pkg = language === 'py' ? specifier.split('.')[0] : packageNameOf(specifier);
    if (pkg) {
      if (language === 'py' && isPythonStdlib(pkg)) {
        return { ...base, kind: 'stdlib', pkg };
      }
      // Node 内置模块同样不是架构依赖（node:fs 与 fs 都要认）
      if (language !== 'py' && isNodeBuiltin(specifier)) {
        return { ...base, kind: 'stdlib', pkg: specifier };
      }
      if (ctx.isWorkspaceDep(pkg)) {
        // monorepo 内部包：指向该包目录的入口（如果索引里有）
        const target = tryCandidates([`packages/${pkg}`, pkg], language, ctx.index);
        if (target) return { ...base, kind: 'internal', target };
      }
      return { ...base, kind: 'external', pkg };
    }
  }

  return { ...base, kind: 'unresolved' };
}

/**
 * 在索引里尝试一组候选路径，补全后缀与 index 文件。
 *
 * 候选顺序即优先级：调用方必须把"更具体"的候选放在前面。
 *
 * @param {string[]} candidates
 * @param {import('./lang.mjs').Language} language
 * @param {ModuleIndex} index
 * @returns {string | null}
 */
function tryCandidates(candidates, language, index) {
  const exts = EXT_CANDIDATES[language] || [];
  const indexes = INDEX_CANDIDATES[language] || [];

  for (const raw of candidates) {
    const cand = normalizePosix(raw);
    if (!cand) continue;
    if (index.files.has(cand)) return cand;
    for (const ext of exts) {
      if (index.files.has(cand + ext)) return cand + ext;
    }
    for (const idx of indexes) {
      const p = `${cand}/${idx}`;
      if (index.files.has(p)) return p;
    }
    // Python 里"包"本身就是被导入的对象（from app import x 里的 app），
    // 此时目标是 __init__.py 而不是某个 .py 文件，扩展名补全查不到。
    if (language === 'py' && index.dirs.has(cand)) {
      for (const init of ['__init__.py', '__init__.pyi']) {
        const p = `${cand}/${init}`;
        if (index.files.has(p)) return p;
      }
    }
  }
  return null;
}
