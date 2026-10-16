import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  isPackageImportsSpecifier,
  importsMapOf,
  resolvePackageImports,
} from '../src/pkg-imports.mjs';
import { normalizePosix, buildIndex, resolveRef } from '../src/resolve.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));

async function scaffold(name, files) {
  const dir = join(tmpdir(), `archsvg-imports-${name}-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

const pkg = (imports) => JSON.stringify({ name: 'x', type: 'module', imports }, null, 2);

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

test('isPackageImportsSpecifier 只认 # 开头', () => {
  assert.equal(isPackageImportsSpecifier('#a'), true);
  assert.equal(isPackageImportsSpecifier('#'), true);
  assert.equal(isPackageImportsSpecifier('./a'), false);
  assert.equal(isPackageImportsSpecifier('react'), false);
  assert.equal(isPackageImportsSpecifier({}), false);
});

test('importsMapOf 取出映射并按 pattern 排序（保证确定性）', () => {
  const map = importsMapOf({ imports: { '#b/*': './b/*', '#a': './a.js' } });
  assert.deepEqual(map.map((m) => m.pattern), ['#a', '#b/*']);
});

test('importsMapOf 支持条件对象与数组形式', () => {
  const map = importsMapOf({
    imports: {
      '#cond': { node: './node.js', default: './browser.js' },
      '#arr': ['./one.js', './two.js'],
      '#bad': 42,
    },
  });
  const byPattern = Object.fromEntries(map.map((m) => [m.pattern, [...m.targets].sort()]));
  assert.deepEqual(byPattern['#cond'], ['./browser.js', './node.js']);
  assert.deepEqual(byPattern['#arr'], ['./one.js', './two.js']);
  assert.equal(byPattern['#bad'], undefined, '非字符串目标应被忽略');
});

test('importsMapOf 对缺失/非法 imports 返回 null', () => {
  assert.equal(importsMapOf({}), null);
  assert.equal(importsMapOf({ imports: 'nope' }), null);
  assert.equal(importsMapOf(null), null);
  assert.equal(importsMapOf({ imports: {} }), null);
});

test('resolvePackageImports：目标相对 package.json 所在目录，而不是引用方文件', () => {
  const imports = importsMapOf({ imports: { '#utils/*': './src/utils/*' } });
  const normalize = (dir, rel) => normalizePosix(dir ? `${dir}/${rel}` : rel);
  // 引用方在 packages/a/src，但 package.json 在 packages/a
  assert.deepEqual(
    resolvePackageImports('#utils/x.js', imports, 'packages/a', normalize),
    ['packages/a/src/utils/x.js'],
  );
});

test('resolvePackageImports：精确匹配与 * 通配', () => {
  const imports = importsMapOf({
    imports: { '#config': './src/config.js', '#utils/*': './src/utils/*' },
  });
  const normalize = (dir, rel) => normalizePosix(dir ? `${dir}/${rel}` : rel);
  assert.deepEqual(resolvePackageImports('#config', imports, '', normalize), ['src/config.js']);
  assert.deepEqual(resolvePackageImports('#utils/date.js', imports, '', normalize), ['src/utils/date.js']);
  // 精确 pattern 不该被通配误命中
  assert.deepEqual(resolvePackageImports('#other/x', imports, '', normalize), []);
});

test('resolvePackageImports：前后缀都能带通配', () => {
  const imports = importsMapOf({ imports: { '#feat/*/index.js': './src/*/index.js' } });
  const normalize = (dir, rel) => normalizePosix(dir ? `${dir}/${rel}` : rel);
  assert.deepEqual(
    resolvePackageImports('#feat/auth/index.js', imports, '', normalize),
    ['src/auth/index.js'],
  );
  assert.deepEqual(resolvePackageImports('#feat/auth/other.js', imports, '', normalize), []);
});

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

test('# 别名解析成内部依赖，且不留假的外部包', async () => {
  const dir = await scaffold('basic', {
    'package.json': pkg({ '#utils/*': './src/utils/*', '#config': './src/config.js' }),
    'src/utils/date.js': 'export const d = 1;\n',
    'src/config.js': 'export const c = 1;\n',
    'src/a.js': "import { d } from '#utils/date.js';\nimport { c } from '#config';\nexport const v = d + c;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    assert.deepEqual(
      r.graph.edges.map((e) => `${e.from}->${e.to}`).sort(),
      ['src/a.js->src/config.js', 'src/a.js->src/utils/date.js'],
    );
    assert.equal(r.graph.stats.externalCount, 0, '不该把 # 别名当成外部包');
    assert.equal(r.extras.unresolved, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('# 别名：深层文件也能找到仓库根的 package.json', async () => {
  const dir = await scaffold('deep', {
    'package.json': pkg({ '#lib/*': './src/lib/*' }),
    'src/lib/x.js': 'export const x = 1;\n',
    'packages/app/src/deep/nested/a.js': "import { x } from '#lib/x';\nexport const v = x;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    assert.deepEqual(
      r.graph.edges.map((e) => `${e.from}->${e.to}`),
      ['packages/app/src/deep/nested/a.js->src/lib/x.js'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('# 别名：最近的 package.json 优先', async () => {
  const dir = await scaffold('nearest', {
    'package.json': pkg({ '#lib/*': './root-lib/*' }),
    'root-lib/a.js': 'export const a = 1;\n',
    'packages/p/package.json': pkg({ '#lib/*': './inner-lib/*' }),
    'packages/p/inner-lib/b.js': 'export const b = 1;\n',
    'packages/p/src/m.js': "import { b } from '#lib/b';\nexport const v = b;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    const edges = r.graph.edges.map((e) => `${e.from}->${e.to}`);
    assert.deepEqual(edges, ['packages/p/src/m.js->packages/p/inner-lib/b.js'], JSON.stringify(edges));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('# 别名：没有映射时是 unresolved，不是外部包', async () => {
  const dir = await scaffold('unmapped', {
    'package.json': pkg({ '#known': './src/known.js' }),
    'src/known.js': 'export const k = 1;\n',
    'src/a.js': "import { m } from '#missing';\nexport const v = m;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    assert.equal(r.graph.stats.externalCount, 0, '#missing 不该变成外部包');
    assert.equal(r.extras.unresolved, 1);
    assert.ok(r.diagnostics.some((d) => d.code === 'unresolved-import' && d.message.includes('#missing')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('# 别名：没有 package.json 时也不会崩', async () => {
  const dir = await scaffold('nopkg', {
    'src/a.js': "import { m } from '#whatever';\nexport const v = m;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    assert.equal(r.graph.stats.nodeCount, 1);
    assert.equal(r.graph.stats.externalCount, 0);
    assert.equal(r.extras.unresolved, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('# 别名与 tsconfig 别名可以共存', async () => {
  const dir = await scaffold('coexist', {
    'package.json': pkg({ '#hash/*': './src/hash/*' }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@at/*': ['src/at/*'] } },
    }),
    'src/hash/h.js': 'export const h = 1;\n',
    'src/at/a.js': 'export const a = 1;\n',
    'src/m.js': "import { h } from '#hash/h';\nimport { a } from '@at/a';\nexport const v = h + a;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    assert.deepEqual(
      r.graph.edges.map((e) => `${e.from}->${e.to}`).sort(),
      ['src/m.js->src/at/a.js', 'src/m.js->src/hash/h.js'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveRef：imports 目标必须按 package.json 所在目录解析（用错 normalize 会让候选变空）', () => {
  const index = buildIndex([
    { path: 'src/utils/x.js', dir: 'src/utils', name: 'x.js', bytes: 1, lines: 1, language: 'js' },
  ]);
  const ctx = {
    index,
    tsconfig: null,
    packageImports: { dir: '', imports: importsMapOf({ imports: { '#utils/*': './src/utils/*' } }) },
    languageOf: () => 'js',
    isWorkspaceDep: () => false,
  };
  const r = resolveRef({ relPath: 'src/a.js', specifier: '#utils/x.js', line: 1, kind: 'static' }, ctx);
  assert.equal(r.kind, 'internal');
  assert.equal(r.target, 'src/utils/x.js');
});

void here;
