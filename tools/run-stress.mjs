/**
 * 依次运行 tools/stress*.mjs，任何一套失败就停下并以非 0 退出。
 *
 * 单独写成脚本而不是 package.json 里一句 shell 循环，
 * 是因为 Windows 的 cmd 与 POSIX shell 的循环写法不同，
 * 跨平台 npm script 用 shell 语法很容易在另一个平台上报错。
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const files = (await readdir(here))
  .filter((f) => /^stress\d*\.mjs$/.test(f))
  .sort((a, b) => {
    const na = Number(/(\d+)/.exec(a)?.[1] ?? 1);
    const nb = Number(/(\d+)/.exec(b)?.[1] ?? 1);
    return na - nb;
  });

if (files.length === 0) {
  console.error('没有找到任何 stress*.mjs');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`);
  try {
    const { stdout, stderr } = await run(process.execPath, [join(here, file)], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    // 只保留最后一行汇总，避免把每个断言都刷出来
    const last = stdout.trim().split('\n').pop() ?? '';
    if (stderr.trim()) process.stderr.write(stderr);
    console.log(last);
  } catch (err) {
    failed += 1;
    console.error(`失败: ${file}`);
    const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    console.error(text.split('\n').slice(-25).join('\n'));
  }
}

console.log(`\n${files.length - failed}/${files.length} 个套件通过`);
process.exit(failed > 0 ? 1 : 0);
