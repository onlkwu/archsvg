import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIndex,
  resolveRef,
  loadTsconfig,
  applyPaths,
  parseJsonc,
  normalizePosix,
  packageNameOf,
  resolvePythonBare,
} from '../src/resolve.mjs';
import { isPythonStdlib } from '../src/py-stdlib.mjs';
import { isNodeBuiltin } from '../src/node-builtins.mjs';
import { analyzeFixture, fixture } from './helpers/fixtures.mjs';

const quietLog = { warn() {}, diagnostics: [] };

/** 造一个最小索引，只声明这些文件存在 */
function indexOf(paths) {
  return buildIndex(
    paths.map((p) => ({
      path: p,
      dir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '',
      name: p.slice(p.lastIndexOf('/') + 1),
      bytes: 1,
      lines: 1,
      language: p.endsWith('.py') ? 'py' : 'ts',
    })),
  );
}

function resolve(specifier, from, files, tsconfig = null) {
  const index = indexOf(files);
  const lang = from.endsWith('.py') ? 'py' : 'ts';
  return resolveRef(
    { relPath: from, specifier, line: 1, kind: 'static' },
    { index, tsconfig, languageOf: () => lang, isWorkspaceDep: () => false },
  );
}

// ---------------------------------------------------------------------------
// normalizePosix / packageNameOf
// ---------------------------------------------------------------------------

test('normalizePosix 折叠 . 与 .. 并去掉多余斜杠', () => {
  assert.equal(normalizePosix('a/b/../c'), 'a/c');
  assert.equal(normalizePosix('./a//b'), 'a/b');
  assert.equal(normalizePosix('a/./b/../../c'), 'c');
  assert.equal(normalizePosix(''), '');
});

test('packageNameOf 处理 scoped 包并拒绝相对路径', () => {
  assert.equal(packageNameOf('react'), 'react');
  assert.equal(packageNameOf('lodash/fp'), 'lodash');
  assert.equal(packageNameOf('@scope/pkg'), '@scope/pkg');
  assert.equal(packageNameOf('@scope/pkg/sub'), '@scope/pkg');
  // 相对路径必须返回 null，否则 "./missing" 会被当成名叫 "." 的包
  assert.equal(packageNameOf('./missing'), null);
  assert.equal(packageNameOf('../up'), null);
  assert.equal(packageNameOf('@scope'), null);
});

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

test('parseJsonc 支持注释与尾逗号', () => {
  const src = `{
    // 行注释
    "a": 1, /* 块注释 */
    "b": [1, 2,],
    "c": "http://x//y",
  }`;
  assert.deepEqual(parseJsonc(src), { a: 1, b: [1, 2], c: 'http://x//y' });
});

test('parseJsonc 不会把字符串里的引号当结构', () => {
  assert.deepEqual(parseJsonc('{"a": "he said \\"hi\\""}'), { a: 'he said "hi"' });
});

// ---------------------------------------------------------------------------
// 相对路径解析
// ---------------------------------------------------------------------------

test('相对路径解析失败时返回 unresolved，而不是伪装成外部包', () => {
  const r = resolve('./missing', 'src/a.ts', ['src/a.ts']);
  assert.equal(r.kind, 'unresolved');
});

test('相对路径补全 .ts 与 index.ts', () => {
  assert.equal(resolve('./b', 'src/a.ts', ['src/a.ts', 'src/b.ts']).target, 'src/b.ts');
  assert.equal(
    resolve('./dir', 'src/a.ts', ['src/a.ts', 'src/dir/index.ts']).target,
    'src/dir/index.ts',
  );
});

test('../ 可以跨目录回到上层', () => {
  const r = resolve('../utils/x', 'src/api/a.ts', ['src/api/a.ts', 'src/utils/x.ts']);
  assert.equal(r.kind, 'internal');
  assert.equal(r.target, 'src/utils/x.ts');
});

// ---------------------------------------------------------------------------
// tsconfig 别名
// ---------------------------------------------------------------------------

test('loadTsconfig 记录配置所在目录（baseUrl 的基准）', async () => {
  const cfg = await loadTsconfig(fixture('mono-app'), quietLog, '');
  assert.equal(cfg.dir, '');
  assert.equal(cfg.file, 'tsconfig.json');
  assert.deepEqual(cfg.paths.map((p) => p.pattern), ['@shared/*']);
});

test('applyPaths 把别名解析到配置文件所在目录', () => {
  const cfg = {
    file: 'tsconfig.json',
    dir: 'packages/a',
    baseUrl: '.',
    paths: [{ pattern: '@core/*', targets: ['src/core/*'] }],
  };
  assert.equal(applyPaths('@core/helper', cfg)[0], 'packages/a/src/core/helper');
});

test('applyPaths 支持多个 target 与精确匹配', () => {
  const cfg = {
    file: 'tsconfig.json',
    dir: '',
    baseUrl: 'src',
    paths: [
      { pattern: 'exact', targets: ['exact-file.ts'] },
      { pattern: '@lib/*', targets: ['lib/*', 'vendor/*'] },
    ],
  };
  assert.deepEqual(applyPaths('exact', cfg), ['src/exact-file.ts', 'src/exact']);
  assert.deepEqual(applyPaths('@lib/x', cfg), ['src/lib/x', 'src/vendor/x', 'src/@lib/x']);
});

test('applyPaths 的 pattern 不匹配时不产出候选', () => {
  const cfg = {
    file: 'tsconfig.json',
    dir: '',
    baseUrl: '.',
    paths: [{ pattern: '@core/*', targets: ['core/*'] }],
  };
  // 只剩"兜底按 baseUrl 解析"这一条，而不是把 @core/x 硬套上去
  assert.deepEqual(applyPaths('@other/x', cfg), ['@other/x']);
});

test('monorepo：每个包用自己的 tsconfig，别包的别名不生效', async () => {
  const r = await analyzeFixture('mono-app');
  const edges = r.graph.edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(edges, [
    'packages/a/src/index.ts->packages/a/src/core/helper.ts',
    'packages/b/src/index.ts->packages/b/src/event.ts',
  ]);
  // 包 b 没有自己的 tsconfig，@core/* 对它来说就是外部包
  const externals = r.graph.nodes.filter((n) => n.external).map((n) => n.label);
  assert.deepEqual(externals, ['@core/helper']);
});

test('monorepo：node: 前缀与旧写法的内置模块都不进图', async () => {
  const r = await analyzeFixture('mono-app');
  const labels = r.graph.nodes.map((n) => n.label);
  for (const b of ['fs', 'path', 'fs/promises', 'node:fs', 'node:path']) {
    assert.equal(labels.includes(b), false, `${b} 不应该出现在图里`);
  }
});

// ---------------------------------------------------------------------------
// Python 解析
// ---------------------------------------------------------------------------

test('isPythonStdlib 认标准库，不认第三方包', () => {
  assert.equal(isPythonStdlib('os'), true);
  assert.equal(isPythonStdlib('dataclasses'), true);
  assert.equal(isPythonStdlib('numpy'), false);
  assert.equal(isPythonStdlib('PIL'), false);
});

test('isNodeBuiltin 同时认 node: 前缀与旧写法', () => {
  assert.equal(isNodeBuiltin('fs'), true);
  assert.equal(isNodeBuiltin('node:fs'), true);
  assert.equal(isNodeBuiltin('fs/promises'), true);
  assert.equal(isNodeBuiltin('express'), false);
  assert.equal(isNodeBuiltin('react'), false);
});

test('Python 包本身可以作为导入目标（指向 __init__.py）', () => {
  const r = resolve('app.core', 'main.py', ['main.py', 'app/__init__.py', 'app/core/__init__.py']);
  assert.equal(r.kind, 'internal');
  assert.equal(r.target, 'app/core/__init__.py');
});

test('Python 包内绝对导入从仓库根解析', () => {
  const files = ['app/__init__.py', 'app/api/__init__.py', 'app/api/routes.py', 'app/core/format.py'];
  const r = resolve('app.core.format', 'app/api/routes.py', files);
  assert.equal(r.kind, 'internal');
  assert.equal(r.target, 'app/core/format.py');
});

test('Python 同目录脚本互引（sys.path 根是当前目录）', () => {
  const files = ['run.py', 'helper.py'];
  const r = resolve('helper', 'run.py', files);
  assert.equal(r.kind, 'internal');
  assert.equal(r.target, 'helper.py');
});

test('resolvePythonBare 走到仓库根就停，不会连上仓库外的同名目录', () => {
  const index = indexOf(['other/app/__init__.py', 'sub/deep/mod.py']);
  // 文件位于 sub/deep，往上找不到 app，必须返回 null 而不是命中 other/app
  assert.equal(resolvePythonBare('sub/deep/mod.py', 'app', index), null);
});

test('Python 相对导入按点数上溯，优先命中更具体的模块', () => {
  const index = indexOf(['app/__init__.py', 'app/api/__init__.py', 'app/api/routes.py', 'app/core/models.py']);
  // 一个点 = 当前包（app.api），两个点 = 上一级（app）
  // 所以从 app/api/routes.py 出发要用 ..core.models 才能到 app/core/models
  assert.equal(resolveTarget('app/api/routes.py', '..core.models', index), 'app/core/models.py');
  assert.equal(resolveTarget('app/api/routes.py', '..core.models.User', index), 'app/core/models.py');
  // 一个点确实指向 app/api 自己；该包下没有 core 子包，退到包本身才是对的
  assert.equal(resolveTarget('app/api/routes.py', '.core.models', index), 'app/api/__init__.py');
  // 同级子模块能被命中
  assert.equal(resolveTarget('app/api/routes.py', '.helpers', index, ['app/api/helpers.py']), 'app/api/helpers.py');
});

test('Python 相对导入不会越出仓库根', () => {
  const index = indexOf(['a.py']);
  assert.equal(resolveTarget('a.py', '...missing', index), null);
});

function resolveTarget(from, spec, index, extra = []) {
  const idx = extra.length > 0 ? indexOf([...extra, ...['a.py']]) : index;
  const r = resolveRef(
    { relPath: from, specifier: spec, line: 1, kind: 'from-import' },
    { index: idx, tsconfig: null, languageOf: () => 'py', isWorkspaceDep: () => false },
  );
  return r.kind === 'internal' ? r.target : null;
}
