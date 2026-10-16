import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan, normalizeRepoArg } from '../src/scan.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('normalizeRepoArg 去掉 ./ 与 .\\ 前缀', () => {
  assert.equal(normalizeRepoArg('./src'), 'src');
  assert.equal(normalizeRepoArg('.\\src'), 'src');
  assert.equal(normalizeRepoArg('././src'), 'src');
  assert.equal(normalizeRepoArg('./'), '.');
  assert.equal(normalizeRepoArg('.'), '.');
  assert.equal(normalizeRepoArg('  ./src  '), 'src');
  assert.equal(normalizeRepoArg(''), '');
  // 不该动正常路径
  assert.equal(normalizeRepoArg('src/a'), 'src/a');
  assert.equal(normalizeRepoArg('C:/x/y'), 'C:/x/y');
  assert.equal(normalizeRepoArg('../up'), '../up');
});

test('normalizeRepoArg 修掉 ./D:/ 这种 Windows 盘符误判', () => {
  // 不加处理时 path.resolve 会拼成 <cwd>\D:\... 这种不存在的路径
  const buggy = resolve('some-cwd', './D:/x/y');
  const fixed = resolve('some-cwd', normalizeRepoArg('./D:/x/y'));
  assert.notEqual(buggy, fixed, '前提：原样 resolve 确实是错的');
  assert.equal(fixed, resolve('D:/x/y'));
  assert.equal(fixed.includes(`${sep}D:${sep}`), false);
});

test('路径写法：相对、绝对、尾斜杠、./ 前缀都能扫到同一批文件', async () => {
  const target = join(here, 'fixtures', 'ts-app');
  const baseline = await scan(target);

  const variants = [
    target,
    target + sep,
    target + '/',
    `.${sep}${target}`.replace(`${sep}${sep}`, sep),
    `./${target.replace(/\\/g, '/')}`,
  ];

  for (const v of variants) {
    const r = await scan(v);
    assert.equal(r.files.length, baseline.files.length, `路径写法失败: ${v}`);
    assert.equal(r.root, baseline.root, `root 归一化失败: ${v}`);
  }
});

test('路径写法：相对当前工作目录的写法也能用', async () => {
  const rel = './test/fixtures/ts-app';
  const r = await scan(rel);
  assert.equal(r.files.length, 6);
  assert.equal(r.root, resolve(here, '..', 'test', 'fixtures', 'ts-app'));
});

test('./D:/ 形式的路径真的能被扫描（端到端）', async () => {
  const target = join(here, 'fixtures', 'clean-app');
  // 只在 Windows 上构造这种写法（盘符语义）
  const dotted = `./${target.replace(/\\/g, '/')}`;
  const r = await scan(dotted);
  assert.equal(r.files.length, 2, `扫描失败: ${dotted}`);
});

test('analyze 也走同一套路径归一化', async () => {
  const target = resolve(here, 'fixtures', 'clean-app');
  const dotted = `./${target.replace(/\\/g, '/')}`;
  const r = await analyzeFixture(dotted);
  assert.equal(r.graph.stats.nodeCount, 2);
});

test('不存在的路径报错信息里带上原始输入', async () => {
  const bogus = join(tmpdir(), 'archsvg-definitely-missing-xyz');
  await assert.rejects(() => scan(bogus), (err) => {
    assert.equal(err.code, 'ENOTDIR_INPUT');
    assert.ok(err.message.includes('archsvg-definitely-missing-xyz'));
    return true;
  });
  // 带 ./ 前缀时也应报同一个错，而不是拼出一个诡异的路径
  await assert.rejects(() => scan(`./${bogus}`), (err) => err.code === 'ENOTDIR_INPUT');
});

test('空目录与只有忽略项的空仓库都能安全返回', async () => {
  const dir = join(tmpdir(), `archsvg-empty-${Date.now()}`);
  await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n', 'utf8');
  try {
    const r = await scan(dir);
    assert.equal(r.files.length, 0);
    assert.ok(r.stats.skippedIgnored >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
