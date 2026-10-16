/**
 * 按扩展名判定语言。
 *
 * 只判定"能不能解析"这一件事，不做更聪明的推断——
 * 靠内容猜语言会带来不确定性，而不确定性是架构图的敌人。
 */

/** @typedef {'js' | 'ts' | 'py' | 'generic'} Language */

const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const TS_EXT = new Set(['.ts', '.mts', '.cts', '.tsx']);
const PY_EXT = new Set(['.py', '.pyi']);
const GENERIC_EXT = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.java']);

/** 无扩展名但值得看一眼的文件 */
const GENERIC_BASENAMES = new Set(['Makefile', 'makefile', 'GNUmakefile']);

/** 源文件扩展名全集，供 scan 快速过滤 */
export const SOURCE_EXTENSIONS = new Set([
  ...JS_EXT,
  ...TS_EXT,
  ...PY_EXT,
  ...GENERIC_EXT,
]);

/**
 * @param {string} relPath 仓库内相对路径（POSIX 分隔符）
 * @returns {Language | null} null 表示不解析
 */
export function detectLanguage(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : '';

  // .d.ts 是声明文件，不含依赖信息
  if (base.endsWith('.d.ts')) return null;
  // 压缩产物没有解析价值
  if (/\.min\.(js|mjs|cjs)$/i.test(base)) return null;

  if (JS_EXT.has(ext)) return 'js';
  if (TS_EXT.has(ext)) return 'ts';
  if (PY_EXT.has(ext)) return 'py';
  if (GENERIC_EXT.has(ext)) return 'generic';
  if (GENERIC_BASENAMES.has(base)) return 'generic';
  return null;
}

/** 该语言是否允许"裸标识符即外部包"的解析（C 的尖括号 include 不是包管理器语义） */
export function supportsBareSpecifier(lang) {
  return lang === 'js' || lang === 'ts' || lang === 'py';
}
