import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan, normalizeRel, normalizeRepoArg } from '../src/scan.mjs';
import { compileGlob, matchesGlob } from '../src/rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// normalizeRel 本身
// ---------------------------------------------------------------------------

test('normalizeRel：反斜杠转正斜杠', () => {
  assert.equal(normalizeRel('src\\ui\\page.ts'), 'src/ui/page.ts');
  assert.equal(normalizeRel('src\\ui\\'), 'src/ui/');
});

test('normalizeRel：去掉任意多个前导 ./', () => {
  assert.equal(normalizeRel('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRel('././src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRel('./././src/a.ts'), 'src/a.ts');
  assert.equal(normalizeRel('./'), '');
  assert.equal(normalizeRel('.'), '.');
});

test('normalizeRel：去掉前导斜杠（gitignore 习惯写法）', () => {
  assert.equal(normalizeRel('/lib/'), 'lib/');
  assert.equal(normalizeRel('/src/a.ts'), 'src/a.ts');
});

test('normalizeRel：折叠中间重复斜杠但保留标记目录的尾斜杠', () => {
  assert.equal(normalizeRel('src//ui//a.ts'), 'src/ui/a.ts');
  assert.equal(normalizeRel('src//ui//'), 'src/ui/');
});

test('normalizeRel：空值与 null 不炸', () => {
  assert.equal(normalizeRel(''), '');
  assert.equal(normalizeRel(null), '');
  assert.equal(normalizeRel(undefined), '');
});

// ---------------------------------------------------------------------------
// 忽略规则的各种写法必须等价
// ---------------------------------------------------------------------------

/** 造一个用于忽略测试的小仓库 */
async function scaffoldIgnoreRepo() {
  const dir = join(tmpdir(), `archsvg-ignore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  for (const d of ['src/keep', 'lib', 'packages/x/src', 'packages/y/src']) {
    await mkdir(join(dir, d), { recursive: true });
  }
  await writeFile(join(dir, 'src/keep/a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(dir, 'lib/b.ts'), 'export const b = 1;\n', 'utf8');
  await writeFile(join(dir, 'packages/x/src/c.ts'), 'export const c = 1;\n', 'utf8');
  await writeFile(join(dir, 'packages/y/src/d.ts'), 'export const d = 1;\n', 'utf8');
  return dir;
}

test('--ignore 的写法变体全部等价（多层 ./ 前缀也要生效）', async () => {
  const repo = await scaffoldIgnoreRepo();
  try {
    const baseline = await scan(repo, { ignore: ['lib/'] });
    const baselinePaths = baseline.files.map((f) => f.path).sort();
    assert.equal(baselinePaths.includes('lib/b.ts'), false, '基准：lib/ 应该排除 lib');

    const variants = [
      './lib/',
      '././lib/',
      '/lib/',
      'lib\\',
      'lib\\\\',
      './lib',
      'lib',
      '/lib',
    ];
    for (const v of variants) {
      const r = await scan(repo, { ignore: [v] });
      assert.equal(
        r.files.some((f) => f.path.startsWith('lib/')),
        false,
        `--ignore "${v}" 没有排除 lib/`,
      );
      // 不该顺手把别的目录也干掉
      assert.deepEqual(
        r.files.map((f) => f.path).sort(),
        baselinePaths,
        `--ignore "${v}" 的结果与基准不同`,
      );
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('--ignore 不会把无关目录一起排除', async () => {
  const repo = await scaffoldIgnoreRepo();
  try {
    // `lib` 作为"任意层级的名字"匹配，但不该命中 src/keep 或 packages
    const r = await scan(repo, { ignore: ['lib'] });
    const paths = r.files.map((f) => f.path).sort();
    assert.deepEqual(paths, ['packages/x/src/c.ts', 'packages/y/src/d.ts', 'src/keep/a.ts']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('--ignore 的 glob 形式：** 与 * 的作用范围不同', async () => {
  const repo = await scaffoldIgnoreRepo();
  try {
    const deep = await scan(repo, { ignore: ['**/src/**'] });
    assert.deepEqual(deep.files.map((f) => f.path).sort(), ['lib/b.ts'], '** 应该穿多层');

    const shallow = await scan(repo, { ignore: ['packages/*/src/c.ts'] });
    assert.deepEqual(
      shallow.files.map((f) => f.path).sort(),
      ['lib/b.ts', 'packages/y/src/d.ts', 'src/keep/a.ts'],
      '* 只匹配一层，不该带走 packages/y',
    );

    const oneLayer = await scan(repo, { ignore: ['packages/*/src/'] });
    assert.deepEqual(oneLayer.files.map((f) => f.path).sort(), ['lib/b.ts', 'src/keep/a.ts']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('--ignore 传空字符串或空白不会误伤所有文件', async () => {
  const repo = await scaffoldIgnoreRepo();
  try {
    const all = await scan(repo, { ignore: [] });
    const total = all.files.length;

    const empty = await scan(repo, { ignore: [''] });
    assert.equal(empty.files.length, total, '空字符串不该排除任何东西');

    const spaces = await scan(repo, { ignore: ['   '] });
    assert.equal(spaces.files.length, total, '纯空白不该排除任何东西');

    const dots = await scan(repo, { ignore: ['.'] });
    assert.equal(dots.files.length, total, '单独的 . 不该排除任何东西');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 规则 pattern 与忽略规则应该共享同一套归一化语义
// ---------------------------------------------------------------------------

test('rules 与 scan 的路径归一化语义一致', () => {
  // 规则侧：compileGlob 归一化 ./ 与反斜杠
  const canon = compileGlob('src/ui/**');
  for (const raw of ['./src/ui/**', '././src/ui/**', 'src\\ui\\**', 'src/ui/']) {
    assert.equal(matchesGlob('src/ui/page.ts', compileGlob(raw)), matchesGlob('src/ui/page.ts', canon), raw);
  }
  // 扫描侧：normalizeRel 归一化同样的前缀
  for (const raw of ['./src/ui/', '././src/ui/', 'src\\ui\\', '/src/ui/']) {
    assert.equal(normalizeRel(raw), 'src/ui/', raw);
  }
});

test('normalizeRepoArg 与 normalizeRel 的分工不重叠', () => {
  // 仓库参数要保留 '.' 表示当前目录；忽略规则里的 '.' 应被当作无意义输入
  assert.equal(normalizeRepoArg('./'), '.');
  assert.equal(normalizeRepoArg('.'), '.');
  assert.equal(normalizeRepoArg(''), '');
  assert.equal(normalizeRel('.'), '.');
});

void here;
