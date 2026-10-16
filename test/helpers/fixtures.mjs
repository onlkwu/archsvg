/**
 * 测试共用工具。
 *
 * 单独一个文件是为了让每个测试文件只关心自己的断言，
 * 不用重复处理 fixture 路径和静默日志这些噪音。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../../src/analyze.mjs';
import { Log } from '../../src/log.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** fixture 目录的绝对路径 */
export function fixture(name) {
  return join(here, '..', 'fixtures', name);
}

/** 完全不往 stderr 打字的 Log（测试用） */
export function quietLog() {
  const log = new Log();
  log.quiet = true;
  log.silent = true;
  return log;
}

/**
 * 跑一次分析，默认静默。
 *
 * name 既可以是 fixtures 下的名字，也可以是任意路径。
 * 判定顺序很关键：先看 fixtures 下有没有同名的，有就用它；
 * 否则才当成调用方自己给的路径——否则传进来的绝对路径
 * 会被无条件拼上 fixtures 前缀，在 Windows 上直接拼成一个不存在的路径。
 */
export function analyzeFixture(name, opts = {}) {
  const asFixture = fixture(name);
  const target = existsSync(asFixture) ? asFixture : name;
  return analyze(target, { log: quietLog(), ...opts });
}
