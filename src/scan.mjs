/**
 * 目录遍历。
 *
 * 三条纪律：
 * 1. 遍历顺序必须确定（每层子项按名字排序），否则后面所有环节都不稳定
 * 2. 不在扫描阶段持有文件内容（只留元数据），避免大仓库爆内存
 * 3. 任何"跳过"都要留下诊断，用户必须能问出"为什么我的文件没进图"
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { detectLanguage } from './lang.mjs';

/** 默认忽略目录（构建产物、依赖、缓存）。node_modules 在扫描前就被排除。 */
export const DEFAULT_IGNORES = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.tox/',
  'target/',
  'vendor/',
  'Pods/',
];

export const DEFAULT_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxFileLines: 20000,
  maxFiles: 5000,
  maxAvgLineLength: 300,
};

export const DEFAULT_TEST_PATTERNS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/test_*.py',
  '**/*_test.py',
];

/**
 * 把忽略项编译成正则。
 *
 * 判定顺序很关键，必须先问"有没有通配符"，再问"是不是目录形式"：
 * 反过来会让 `packages/*​/src/` 走进目录分支，`*` 被当字面量转义，
 * 这条规则就永远匹配不上任何文件——一个静默失效的通配忽略规则。
 *
 * @param {string[]} patterns
 */
function compileIgnores(patterns) {
  return patterns.map((raw) => {
    // 统一走 normalizeRel，而不是只剥一层 `./`：
    // 这样 `./lib/`、`././lib/`、`/lib/`、`lib\` 与 `lib/` 完全等价。
    // 只剥一层的话，带多层前缀的写法（从编辑器复制路径时很常见）会静默失效——
    // 静默失效比报错危险，用户会以为某个目录已经被排除了。
    const p = normalizeRel(raw);
    const isDir = p.endsWith('/');
    const body = isDir ? p.slice(0, -1) : p;

    if (body.includes('*') || body.includes('?')) {
      // globToRe 自己会补 `(?:/.*)?`，所以 `packages/*/src` 也能匹配其下所有文件，
      // 不需要为尾斜杠做特殊处理。
      return { raw, re: new RegExp(`^${globToRe(body)}$`) };
    }
    if (isDir) {
      // 明确写成目录：只按"路径段前缀"匹配
      return { raw, re: new RegExp(`(^|/)${escapeRe(body)}/`) };
    }
    // 文件名或目录名：出现在任意层级都忽略
    return { raw, re: new RegExp(`(^|/)${escapeRe(body)}($|/)`) };
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 只支持 ** * ? 三种，够用且行为可预测。
 *
 * 关键细节：** 在开头时表示"零层或多层目录"，必须整体可选。
 * 朴素展开会得到 `^(?:.*\/)?tests\/` —— 对 `tests/c.ts` 来说 `.*\/` 只能匹配空，
 * 于是正则要求路径必须以 `tests//` 开头，永远匹配不上。
 * 这个 bug 会让 `**\/tests/**` 这种最常用的排除规则静默失效。
 */
function globToRe(pattern) {
  // 开头的 **/ 单独处理成可选前缀，避免它和后面的字面量斜杠叠加
  let rest = pattern;
  let prefix = '';
  if (rest.startsWith('**/')) {
    prefix = '(?:[^/]+/)*';
    rest = rest.slice(3);
  }

  let out = '';
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    if (c === '*') {
      if (rest[i + 1] === '*') {
        i += 1;
        if (rest[i + 1] === '/') i += 1;
        // 中间的 ** 可以代表任意层目录（含零层）
        if (out.endsWith('/')) out = out.slice(0, -1);
        out += '(?:/.*)?';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeRe(c);
    }
  }
  return `${prefix}${out}`;
}

/**
 * 判断一个仓库内相对路径是否被忽略。
 * @param {string} rel
 * @param {{raw: string, re: RegExp}[]} compiled
 */
function isIgnored(rel, compiled) {
  return compiled.some((c) => c.re.test(rel));
}

/**
 * @typedef {object} FileInfo
 * @property {string} path      仓库内 POSIX 相对路径
 * @property {string} dir       所在目录（POSIX，根目录为 ''）
 * @property {string} name      文件名
 * @property {number} bytes
 * @property {number} lines
 * @property {import('./lang.mjs').Language} language
 */

/**
 * 归一化用户传入的仓库路径。
 *
 * `./D:/foo` 是个真实的坑：Windows 上带盘符的路径本身已经是绝对的，
 * 但多了 `./` 前缀后 path.resolve 会把它当普通相对段，
 * 拼成 `C:\cwd\D:\foo` 这种根本不存在的路径——用户看到的是"不是有效目录"，
 * 却完全猜不到原因（从资源管理器复制路径、或在某些 shell 里补全时很容易出现）。
 *
 * @param {string} input
 * @returns {string}
 */
export function normalizeRepoArg(input) {
  let p = String(input ?? '').trim();
  if (p === '') return p;
  // 去掉一个或多个 ./ 与 .\ 前缀
  for (;;) {
    if (p.startsWith('./') || p.startsWith('.\\')) {
      p = p.slice(2);
      continue;
    }
    break;
  }
  return p === '' ? '.' : p;
}

/**
 * 扫描仓库，返回可分析的源文件列表。
 *
 * @param {string} root 绝对或相对的目标目录
 * @param {object} [opts]
 * @param {string[]} [opts.ignore]      额外忽略项
 * @param {string[]} [opts.testPatterns] 测试文件模式；传 [] 表示不排除测试
 * @param {number} [opts.maxFiles]
 * @param {import('./log.mjs').Log} [opts.log]
 * @returns {Promise<{ root: string, files: FileInfo[], stats: object }>}
 */
export async function scan(root, opts = {}) {
  const absRoot = resolve(normalizeRepoArg(root));
  const log = opts.log;
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };

  const runStat = await stat(absRoot).catch(() => null);
  if (!runStat || !runStat.isDirectory()) {
    const err = new Error(`不是有效目录: ${root}`);
    err.code = 'ENOTDIR_INPUT';
    throw err;
  }

  const ignoreList = [...DEFAULT_IGNORES, ...(opts.ignore || [])];
  const compiledIgnores = compileIgnores(ignoreList);
  const testPatterns = opts.testPatterns ?? DEFAULT_TEST_PATTERNS;
  const compiledTests = compileIgnores(testPatterns);

  /** @type {FileInfo[]} */
  const files = [];
  const stats = { seen: 0, skippedIgnored: 0, skippedBinary: 0, skippedLarge: 0, skippedNonSource: 0 };

  /** @type {string[]} */
  const queue = [''];
  let overflow = false;

  while (queue.length > 0) {
    const relDir = queue.shift();
    const absDir = relDir ? join(absRoot, relDir) : absRoot;

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      log?.warn('readdir-failed', `无法读取目录: ${err.message}`, { file: relDir || '.' });
      continue;
    }

    // 排序是本模块最重要的三行：它保证同一仓库永远产出同一个图
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();

      if (isIgnored(rel, compiledIgnores)) {
        stats.skippedIgnored += 1;
        continue;
      }
      // 测试文件只在文件粒度上判断，目录名如 test/ 已由上面的 ignore/pattern 处理
      if (!isDir && compiledTests.length > 0 && isIgnored(rel, compiledTests)) {
        stats.skippedIgnored += 1;
        continue;
      }

      if (isDir) {
        queue.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;

      stats.seen += 1;
      if (stats.seen > limits.maxFiles) {
        if (!overflow) {
          overflow = true;
          log?.warn('too-many-files', `文件数超过上限 ${limits.maxFiles}，已停止扫描`);
        }
        continue;
      }

      const language = detectLanguage(rel);
      if (!language) {
        stats.skippedNonSource += 1;
        continue;
      }

      const absFile = join(absRoot, rel);
      const st = await stat(absFile).catch(() => null);
      if (!st) continue;

      if (st.size > limits.maxFileBytes) {
        stats.skippedLarge += 1;
        log?.warn('file-too-large', `文件超过 ${limits.maxFileBytes} 字节，已跳过`, { file: rel });
        continue;
      }
      if (st.size === 0) continue;

      const buf = await readFile(absFile).catch(() => null);
      if (!buf) continue;

      if (isBinary(buf)) {
        stats.skippedBinary += 1;
        continue;
      }

      const text = buf.toString('utf8');
      const lineCount = countLines(text);
      if (lineCount > limits.maxFileLines) {
        stats.skippedLarge += 1;
        log?.warn('file-too-many-lines', `文件超过 ${limits.maxFileLines} 行，已跳过`, { file: rel });
        continue;
      }
      const avgLineLength = text.length / Math.max(1, lineCount);
      if (avgLineLength > limits.maxAvgLineLength) {
        stats.skippedLarge += 1;
        log?.warn('file-minified', `疑似压缩产物（平均行长 ${Math.round(avgLineLength)}），已跳过`, {
          file: rel,
        });
        continue;
      }

      files.push({
        path: rel,
        dir: relDir,
        name: entry.name,
        bytes: st.size,
        lines: lineCount,
        language,
      });
    }
  }

  // 队列是 BFS，文件顺序不完全等于字典序；这里统一重排，作为下游一切排序的起点
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { root: absRoot, files, stats };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function countLines(text) {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  // 末尾换行不算多一行
  if (text.charCodeAt(text.length - 1) === 10) n -= 1;
  return n;
}

/**
 * 归一化"仓库内相对路径"的写法，供忽略规则与规则文件的 pattern 共用。
 *
 * 处理四件事：反斜杠转正斜杠、去掉任意多个前导 `./`、去掉前导 `/`、
 * 去掉多余的斜杠（保留用于标记目录的尾斜杠）。
 *
 * 前导 `/` 也去掉是因为用户会按 gitignore 的习惯写 `/lib/`；
 * 在"仓库内相对路径"的语境下它和 `lib/` 是同一个意思。
 *
 * @param {string} p
 */
export function normalizeRel(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  // 折叠中间的重复斜杠，但保留结尾那一个（它标记"这是目录"）
  const trailing = s.endsWith('/') && s !== '/';
  s = s.replace(/\/{2,}/g, '/');
  if (trailing && !s.endsWith('/')) s += '/';
  return s;
}
