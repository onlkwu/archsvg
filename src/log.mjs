/**
 * 诊断收集器。
 *
 * 设计意图：扫描/解析过程中所有"不致命但值得说"的事情都写进这里，
 * 不直接往 stderr 打字。调用方（CLI / 测试）可以决定怎么呈现。
 *
 * 关于 --quiet 的取舍：它只压掉**信息性**输出，不压警告。
 * 理由是警告属于"结果可能不对"的信号——比如 tsconfig 的别名没解析出来，
 * 用户会看到一堆莫名其妙的"外部包"，这时如果因为 --quiet 而没有任何提示，
 * 就完全无从排查。宁可多打几行，也不要让用户面对一个静默错误的结果。
 */

/** @typedef {{ code: string, message: string, file?: string, line?: number }} Diagnostic */

export class Log {
  constructor() {
    /** @type {Diagnostic[]} */
    this.diagnostics = [];
    /** 压掉信息性输出 */
    this.quiet = false;
    /** 连警告也不打（测试与库调用用） */
    this.silent = false;
    /** 同一 code+file 只打一次，避免大仓库刷屏 */
    this.dedupe = true;
    /** @type {Set<string>} */
    this.emitted = new Set();
  }

  /**
   * 记录一条警告。默认同时打到 stderr。
   *
   * @param {string} code
   * @param {string} message
   * @param {{ file?: string, line?: number }} [where]
   */
  warn(code, message, where = {}) {
    const d = { code, message, ...where };
    this.diagnostics.push(d);

    if (this.silent) return d;

    const key = `${code}\u0000${where.file ?? ''}`;
    if (this.dedupe && this.emitted.has(key)) return d;
    this.emitted.add(key);

    const at = where.file ? `${where.file}${where.line ? `:${where.line}` : ''}` : '';
    process.stderr.write(`warning [${code}] ${message}${at ? ` (${at})` : ''}\n`);
    return d;
  }

  /**
   * 信息性输出，受 --quiet 控制。
   * @param {string} message
   */
  info(message) {
    if (this.quiet || this.silent) return;
    process.stderr.write(`${message}\n`);
  }

  get count() {
    return this.diagnostics.length;
  }

  /** 按 code 汇总，用于在结尾给一句人话总结 */
  summary() {
    /** @type {Map<string, number>} */
    const byCode = new Map();
    for (const d of this.diagnostics) {
      byCode.set(d.code, (byCode.get(d.code) || 0) + 1);
    }
    return byCode;
  }
}
