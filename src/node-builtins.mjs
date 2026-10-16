/**
 * Node.js 内置模块名。
 *
 * 和 Python 标准库同理：不排除掉，任何 Node 项目的图里都会塞满
 * fs / path / url 这些噪音节点，而架构图的价值在于只显示你该关心的依赖。
 */

export const NODE_BUILTINS = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
  'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'readline/promises', 'repl', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls',
  'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

/**
 * 判断一个裸标识符是否指向 Node 内置模块。
 * 同时识别 `node:` 前缀写法（唯一可靠的做法，但很多代码仍在用旧写法）。
 *
 * @param {string} spec
 */
export function isNodeBuiltin(spec) {
  if (!spec) return false;
  const s = spec.startsWith('node:') ? spec.slice(5) : spec;
  return NODE_BUILTINS.has(s);
}
