import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan } from '../src/scan.mjs';
import { detectLanguage } from '../src/lang.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (name) => join(here, 'fixtures', name);

test('detectLanguage 覆盖主要扩展名', () => {
  assert.equal(detectLanguage('a/b/c.ts'), 'ts');
  assert.equal(detectLanguage('a/b/c.tsx'), 'ts');
  assert.equal(detectLanguage('a/b/c.mjs'), 'js');
  assert.equal(detectLanguage('a/b/c.py'), 'py');
  assert.equal(detectLanguage('a/b/c.cpp'), 'generic');
  assert.equal(detectLanguage('a/b/Makefile'), 'generic');
  // 声明文件与压缩产物不解析
  assert.equal(detectLanguage('a/b/c.d.ts'), null);
  assert.equal(detectLanguage('a/b/c.min.js'), null);
  assert.equal(detectLanguage('a/b/readme.md'), null);
  assert.equal(detectLanguage('a/b/logo.png'), null);
});

test('扫描 ts-app：统计正确的源文件', async () => {
  const { files, stats } = await scan(fix('ts-app'));
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'src/api/server.ts',
    'src/db/client.ts',
    'src/db/user.ts',
    'src/main.ts',
    'src/ui/page.ts',
    'src/utils/format.ts',
  ]);
  assert.equal(stats.seen >= files.length, true);
  // tsconfig.json / package.json 不是源码
  assert.equal(paths.some((p) => p.endsWith('.json')), false);
});

test('扫描结果按路径排序（下游确定性的前提）', async () => {
  const { files } = await scan(fix('ts-app'));
  const paths = files.map((f) => f.path);
  const sorted = [...paths].sort();
  assert.deepEqual(paths, sorted);
});

test('测试文件默认排除，--include-tests 时纳入', async () => {
  const without = await scan(fix('clean-app'));
  assert.equal(without.files.some((f) => f.path.includes('.test.')), false);

  const withTests = await scan(fix('clean-app'), { testPatterns: [] });
  assert.equal(withTests.files.some((f) => f.path.includes('.test.')), true);
});

test('默认忽略项覆盖各种测试目录写法', async () => {
  // 重点覆盖以 **/ 开头的模式（**/tests/** 这类），它们最容易因为
  // 展开方式不对而整体失效——失效是静默的，测试目录会被悄悄画进图里
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = join(tmpdir(), `archsvg-scan-${Date.now()}`);
  try {
    for (const d of ['src/keep', 'tests', 'test', 'src/__tests__', 'src/__mocks__']) {
      await mkdir(join(dir, d), { recursive: true });
    }
    await writeFile(join(dir, 'src/keep/a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(join(dir, 'src/keep/a.test.ts'), 'export const t = 1;\n', 'utf8');
    await writeFile(join(dir, 'src/keep/a.spec.ts'), 'export const s = 1;\n', 'utf8');
    await writeFile(join(dir, 'tests/c.ts'), 'export const c = 1;\n', 'utf8');
    await writeFile(join(dir, 'test/d.ts'), 'export const d = 1;\n', 'utf8');
    await writeFile(join(dir, 'src/__tests__/e.ts'), 'export const e = 1;\n', 'utf8');
    await writeFile(join(dir, 'src/__mocks__/f.ts'), 'export const f = 1;\n', 'utf8');
    await writeFile(join(dir, 'test_g.py'), 'x = 1\n', 'utf8');
    await writeFile(join(dir, 'g_test.py'), 'x = 1\n', 'utf8');

    const { files } = await scan(dir);
    assert.deepEqual(
      files.map((f) => f.path),
      ['src/keep/a.ts'],
      '只应剩下非测试文件',
    );

    // 逐个验证，失败时能直接指出是哪条模式坏了
    for (const p of [
      'src/keep/a.test.ts',
      'src/keep/a.spec.ts',
      'tests/c.ts',
      'test/d.ts',
      'src/__tests__/e.ts',
      'src/__mocks__/f.ts',
      'test_g.py',
      'g_test.py',
    ]) {
      const single = await scan(dir, { ignore: [], limits: { maxFiles: 500 } });
      assert.equal(
        single.files.some((f) => f.path === p),
        false,
        `${p} 应该被默认测试模式排除`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('行数统计正确（末尾换行不额外计一行）', async () => {
  const { files } = await scan(fix('clean-app'));
  const helper = files.find((f) => f.path === 'src/helper.ts');
  assert.ok(helper);
  assert.equal(helper.lines, 3);
});

test('忽略项生效', async () => {
  const { files } = await scan(fix('ts-app'), { ignore: ['src/db/'] });
  assert.equal(files.some((f) => f.path.startsWith('src/db/')), false);
});

test('语言过滤在扫描之后可以收窄', async () => {
  const py = await scan(fix('py-app'));
  assert.equal(py.files.every((f) => f.language === 'py'), true);
});

test('非目录输入抛出可识别错误', async () => {
  await assert.rejects(() => scan(join(here, 'fixtures', 'nope-does-not-exist')), (err) => {
    assert.equal(err.code, 'ENOTDIR_INPUT');
    return true;
  });
});

test('空目录不报错，返回空列表', async () => {
  const { files } = await scan(fix('empty-app'));
  assert.equal(files.length, 0);
});
