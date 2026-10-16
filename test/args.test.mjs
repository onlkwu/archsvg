import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '../bin/cli.mjs';
import { loadRules } from '../src/rules.mjs';

/** 只关心解析出的 flags，断言时更聚焦 */
const flagsOf = (argv) => parseArgs(argv).flags;
const errorsOf = (argv) => parseArgs(argv).errors;

// ---------------------------------------------------------------------------
// 长选项取值
// ---------------------------------------------------------------------------

test('长选项：空格分隔与 = 形式都支持', () => {
  assert.equal(flagsOf(['--out', 'a.svg']).out, 'a.svg');
  assert.equal(flagsOf(['--out=a.svg']).out, 'a.svg');
  assert.equal(flagsOf(['--title=x=y']).title, 'x=y', '只按第一个 = 切分');
});

test('长选项：缺值报错', () => {
  assert.deepEqual(errorsOf(['--out']), ['--out 缺少取值']);
  assert.deepEqual(errorsOf(['--out', '--json']), ['--out 缺少取值']);
});

test('长选项：显式空值报错（否则会被当成没写，静默丢弃）', () => {
  // 空值必须报错而不是当成"没写"：否则 flags.out 是空字符串、
  // 后续按真值判断会走到 stdout 分支，用户以为文件已经生成
  assert.deepEqual(errorsOf(['--out=']), ['--out 的取值不能为空']);
  assert.deepEqual(errorsOf(['--format=']), ['--format 的取值不能为空']);
  assert.deepEqual(errorsOf(['--title=']), ['--title 的取值不能为空']);
});

test('长选项：布尔参数不接受取值', () => {
  assert.deepEqual(errorsOf(['--json=1']), ['--json 是布尔参数，不接受取值']);
  assert.equal(flagsOf(['--json']).json, true);
});

test('长选项：未知参数报错', () => {
  assert.deepEqual(errorsOf(['--nope']), ['未知参数 --nope']);
  assert.deepEqual(errorsOf(['--']), [], '裸 -- 不是未知参数');
});

test('数字选项：非法值报错，合法值转成数字', () => {
  assert.equal(flagsOf(['--max-nodes', '100']).maxNodes, undefined);
  assert.equal(flagsOf(['--max-nodes', '100'])['max-nodes'], 100);
  assert.deepEqual(errorsOf(['--max-nodes', 'abc']), ['--max-nodes 需要数字，收到 "abc"']);
  assert.deepEqual(errorsOf(['--max-nodes', 'NaN']), ['--max-nodes 需要数字，收到 "NaN"']);
  assert.deepEqual(errorsOf(['--max-nodes', 'Infinity']), ['--max-nodes 需要数字，收到 "Infinity"']);
});

test('可重复选项：--ignore 累积，其他选项后者覆盖', () => {
  assert.deepEqual(flagsOf(['--ignore', 'a/', '--ignore', 'b/']).ignore, ['a/', 'b/']);
  assert.equal(flagsOf(['--title', 'A', '--title', 'B']).title, 'B');
  assert.equal(flagsOf(['--format', 'svg', '--format', 'json']).format, 'json');
});

// ---------------------------------------------------------------------------
// 短选项别名
// ---------------------------------------------------------------------------

test('短选项：-o 必须取到值（当成布尔会丢掉路径）', () => {
  assert.equal(flagsOf(['-o', 'out.svg']).out, 'out.svg');
  assert.deepEqual(errorsOf(['-o']), ['-o（--out）缺少取值']);
  assert.deepEqual(errorsOf(['-o', '--json']), ['-o（--out）缺少取值']);
  // 一个字符的 `-` 是"当前目录"的传统写法，不能当成 -o
  assert.equal(flagsOf(['-o=y.svg']).out, undefined, '短选项不支持 = 形式，会被当成未知参数');
});

test('短选项：-h 与 -v 是布尔开关', () => {
  assert.equal(flagsOf(['-h']).help, true);
  assert.equal(flagsOf(['-v']).version, true);
});

test('短选项：未知短参报错', () => {
  assert.deepEqual(errorsOf(['-x']), ['未知参数 -x']);
});

// ---------------------------------------------------------------------------
// 位置参数与 --
// ---------------------------------------------------------------------------

test('裸 - 被当作当前目录', () => {
  const r = parseArgs(['-']);
  assert.deepEqual(r.positionals, ['.']);
  assert.deepEqual(r.errors, []);
});

test('-- 之后的一切都是位置参数（包括像选项的东西）', () => {
  const r = parseArgs(['--', '--weird-dir', '--json']);
  assert.deepEqual(r.positionals, ['--weird-dir', '--json']);
  assert.deepEqual(r.flags, {});
  assert.deepEqual(r.errors, []);
});

test('选项放在 -- 之前才生效', () => {
  const r = parseArgs(['--json', '--', 'repo']);
  assert.equal(r.flags.json, true);
  assert.deepEqual(r.positionals, ['repo']);
});

test('-- 可以直接给带取值的选项当分隔符', () => {
  const r = parseArgs(['--out', '--', '--weird.svg']);
  assert.equal(r.flags.out, '--weird.svg');
  assert.deepEqual(r.errors, []);
});

test('多个位置参数按顺序保留', () => {
  assert.deepEqual(parseArgs(['a', 'b', 'c']).positionals, ['a', 'b', 'c']);
});

test('空参数列表不报错', () => {
  const r = parseArgs([]);
  assert.deepEqual(r.positionals, []);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.flags, {});
});

// ---------------------------------------------------------------------------
// 规则文件的 BOM
// ---------------------------------------------------------------------------

test('loadRules：UTF-8 BOM 被忽略（记事本/PowerShell 存 JSON 的常见情况）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archsvg-bom-'));
  try {
    const file = join(dir, 'rules.json');
    await writeFile(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ schemaVersion: 1, rules: [] }), 'utf8'),
    ]));
    const loaded = await loadRules(file);
    assert.equal(loaded.schemaVersion, 1);
    assert.deepEqual(loaded.rules, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadRules：带 BOM 的内容真的非法时，错误信息要提到 BOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archsvg-bom2-'));
  try {
    const file = join(dir, 'bad.json');
    await writeFile(file, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{ nope', 'utf8'),
    ]));
    await assert.rejects(() => loadRules(file), (err) => {
      assert.equal(err.code, 'RULES_PARSE_FAILED');
      assert.match(err.message, /BOM/, '应提示可能是 BOM 问题');
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
