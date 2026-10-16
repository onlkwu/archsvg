import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadTsconfig, applyPaths, parseJsonc } from '../src/resolve.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const quiet = { warn() {}, diagnostics: [] };

/** 造一个临时仓库，files 是 相对路径 → 内容 */
async function scaffold(name, files) {
  const dir = join(tmpdir(), `archsvg-tsconfig-${name}-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

test('extends：跟随相对路径的基配置', async () => {
  const dir = await scaffold('basic', {
    'base.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
    }),
    'tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: {} }),
  });
  try {
    const cfg = await loadTsconfig(dir, quiet, '');
    assert.ok(cfg, '应该读到配置');
    assert.deepEqual(cfg.paths.map((p) => p.pattern), ['@lib/*']);
    assert.equal(cfg.baseUrl, '.');
    // 别名来自 base.json，基准目录应是仓库根
    assert.deepEqual(applyPaths('@lib/x', cfg), ['src/lib/x', '@lib/x']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：省略 .json 扩展名也能找到', async () => {
  const dir = await scaffold('noext', {
    'tsconfig.base.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@x/*': ['x/*'] } },
    }),
    'tsconfig.json': JSON.stringify({ extends: './tsconfig.base' }),
  });
  try {
    const cfg = await loadTsconfig(dir, quiet, '');
    assert.ok(cfg);
    assert.deepEqual(cfg.paths.map((p) => p.pattern), ['@x/*']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：子配置覆盖基配置的 paths', async () => {
  const dir = await scaffold('override', {
    'base.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@a/*': ['a/*'], '@b/*': ['b/*'] } },
    }),
    'tsconfig.json': JSON.stringify({
      extends: './base.json',
      compilerOptions: { paths: { '@c/*': ['c/*'] } },
    }),
  });
  try {
    const cfg = await loadTsconfig(dir, quiet, '');
    assert.deepEqual(cfg.paths.map((p) => p.pattern), ['@c/*'], '子配置应完全覆盖而不是合并');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：链式（A extends B extends C）', async () => {
  const dir = await scaffold('chain', {
    'c.json': JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@deep/*': ['deep/*'] } } }),
    'b.json': JSON.stringify({ extends: './c.json' }),
    'tsconfig.json': JSON.stringify({ extends: './b.json' }),
  });
  try {
    const cfg = await loadTsconfig(dir, quiet, '');
    assert.ok(cfg);
    assert.deepEqual(cfg.paths.map((p) => p.pattern), ['@deep/*']);
    assert.equal(cfg.baseUrl, 'src');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：成环时不死循环，给出警告', async () => {
  const dir = await scaffold('cycle', {
    'a.json': JSON.stringify({ extends: './b.json' }),
    'b.json': JSON.stringify({ extends: './a.json' }),
    'tsconfig.json': JSON.stringify({ extends: './a.json' }),
  });
  try {
    const warnings = [];
    const log = { warn: (code, msg) => warnings.push({ code, msg }), diagnostics: [] };
    const cfg = await loadTsconfig(dir, log, '');
    // 不要求有结果，只要求不挂、且能说明原因
    assert.ok(warnings.some((w) => w.code === 'tsconfig-extends-cycle'), JSON.stringify(warnings));
    void cfg;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：指向不存在的文件时给出警告', async () => {
  const dir = await scaffold('missing', {
    'tsconfig.json': JSON.stringify({ extends: './nope.json' }),
  });
  try {
    const warnings = [];
    const log = { warn: (code, msg) => warnings.push({ code, msg }), diagnostics: [] };
    await loadTsconfig(dir, log, '');
    assert.ok(warnings.some((w) => w.code === 'tsconfig-extends-missing'), JSON.stringify(warnings));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：指向 npm 包时明确说明未跟随，而不是默默失败', async () => {
  const dir = await scaffold('pkg', {
    'tsconfig.json': JSON.stringify({ extends: '@tsconfig/node20/tsconfig.json' }),
  });
  try {
    const warnings = [];
    const log = { warn: (code, msg) => warnings.push({ code, msg }), diagnostics: [] };
    await loadTsconfig(dir, log, '');
    const w = warnings.find((x) => x.code === 'tsconfig-extends-package');
    assert.ok(w, JSON.stringify(warnings));
    assert.match(w.msg, /node_modules/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：从基配置继承的别名能真的解析出依赖', async () => {
  const dir = await scaffold('e2e', {
    'base.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
    }),
    'tsconfig.json': JSON.stringify({ extends: './base.json' }),
    'src/lib/x.ts': 'export const x = 1;\n',
    'src/a.ts': "import { x } from '@lib/x';\nexport const v = x;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    const edges = r.graph.edges.map((e) => `${e.from}->${e.to}`);
    assert.deepEqual(edges, ['src/a.ts->src/lib/x.ts'], 'extends 继承的别名必须解析成内部依赖');
    assert.equal(r.graph.stats.externalCount, 0, '不该留下假的外部包');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extends：子目录配置继承根配置时，别名基准仍在根', async () => {
  const dir = await scaffold('nested', {
    'base.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } },
    }),
    'tsconfig.json': JSON.stringify({ extends: './base.json' }),
    'packages/a/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.json' }),
    'lib/x.ts': 'export const x = 1;\n',
    'packages/a/src/a.ts': "import { x } from '@lib/x';\nexport const v = x;\n",
  });
  try {
    const r = await analyzeFixture(dir);
    const edges = r.graph.edges.map((e) => `${e.from}->${e.to}`);
    assert.deepEqual(edges, ['packages/a/src/a.ts->lib/x.ts'], JSON.stringify(edges));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tsconfig：注释与尾逗号在 extends 场景下也要能解析', async () => {
  const dir = await scaffold('jsonc', {
    'base.json': `{
      // 别名
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@lib/*": ["lib/*"], },
      },
    }`,
    'tsconfig.json': `{ "extends": "./base.json", /* 继承 */ }`,
  });
  try {
    const cfg = await loadTsconfig(dir, quiet, '');
    assert.ok(cfg);
    assert.deepEqual(cfg.paths.map((p) => p.pattern), ['@lib/*']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseJsonc 对注释里的引号保持稳健', () => {
  const src = `{
    // 这里有个 " 引号
    "a": 1,
    /* 块注释里也有 " 引号 */
    "b": 2
  }`;
  assert.deepEqual(parseJsonc(src), { a: 1, b: 2 });
});

void here;
