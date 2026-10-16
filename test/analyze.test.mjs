import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../src/analyze.mjs';
import { Log } from '../src/log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (name) => join(here, 'fixtures', name);

/** 用完全不输出的 Log，避免测试输出被 warning 淹没 */
const quiet = () => {
  const log = new Log();
  log.quiet = true;
  log.silent = true;
  return log;
};

test('ts-app：别名解析与相对路径解析都正确', async () => {
  const r = await analyze(fix('ts-app'), { log: quiet() });
  const edges = r.graph.edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(edges, [
    'src/api/server.ts->src/db/user.ts',
    'src/main.ts->src/api/server.ts',
    'src/main.ts->src/ui/page.ts',
    'src/main.ts->src/utils/format.ts',
    'src/ui/page.ts->src/db/client.ts',
  ]);
  // express 是外部包，收成一个折叠节点
  assert.equal(r.graph.stats.externalCount, 1);
  assert.ok(r.graph.nodes.some((n) => n.external && n.label === 'express'));
});

test('ts-app：边的 refs 带文件与行号', async () => {
  const r = await analyze(fix('ts-app'), { log: quiet() });
  const edge = r.graph.edges.find((e) => e.from === 'src/ui/page.ts');
  assert.ok(edge);
  assert.deepEqual(edge.refs, [{ file: 'src/ui/page.ts', line: 2 }]);
});

test('cycle-app：三节点环与自环都被识别', async () => {
  const r = await analyze(fix('cycle-app'), { log: quiet() });
  assert.equal(r.graph.stats.cycleCount, 1);
  assert.deepEqual(r.graph.cycles, [['src/a.ts', 'src/b.ts', 'src/c.ts']]);
  const cycleEdges = r.graph.edges.filter((e) => e.isCycle).map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(cycleEdges, ['src/a.ts->src/b.ts', 'src/b.ts->src/c.ts', 'src/c.ts->src/a.ts']);
});

test('cycle-app：自环不会让分析崩溃或产生假节点', async () => {
  const r = await analyze(fix('cycle-app'), { log: quiet() });
  assert.equal(r.graph.stats.nodeCount, 3);
});

test('py-app：相对导入与包初始化都被解析', async () => {
  const r = await analyze(fix('py-app'), { log: quiet() });
  const edges = r.graph.edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(edges, [
    'app/__init__.py->app/api/routes.py',
    'app/__init__.py->app/core/format.py',
    'app/api/routes.py->app/api/__init__.py',
    'app/api/routes.py->app/api/helpers.py',
    'app/api/routes.py->app/core/models.py',
  ]);
});

test('py-app：标准库被过滤，不污染架构图', async () => {
  const r = await analyze(fix('py-app'), { log: quiet() });
  assert.equal(r.extras.unresolved, 0);
  // os / sys / json / datetime / dataclasses 全是标准库，不该出现在图里
  assert.equal(r.graph.stats.externalCount, 0);
  assert.equal(r.graph.nodes.filter((n) => n.external).length, 0);
  assert.equal(r.graph.stats.nodeCount, 7);
});

test('clean-app：测试文件默认不进图，--include-tests 时进图', async () => {
  const without = await analyze(fix('clean-app'), { log: quiet() });
  assert.equal(without.graph.stats.nodeCount, 2);

  const withTests = await analyze(fix('clean-app'), { log: quiet(), includeTests: true });
  assert.equal(withTests.graph.stats.nodeCount, 3);
});

test('空仓库：不抛错，产出 0 节点的图', async () => {
  const r = await analyze(fix('empty-app'), { log: quiet() });
  assert.equal(r.graph.stats.nodeCount, 0);
  assert.equal(r.graph.edges.length, 0);
  assert.equal(r.layout.nodes.length, 0);
});

test('解析不到的导入只产生一次诊断', async () => {
  const log = quiet();
  const r = await analyze(fix('ts-app'), { log });
  // 这个 fixture 里所有导入都能解析，因此不该有 unresolved 诊断
  const unresolved = r.diagnostics.filter((d) => d.code === 'unresolved-import');
  assert.equal(unresolved.length, 0);
  assert.equal(r.extras.unresolved, 0);
});

test('--group-dir 会把文件聚合成目录节点', async () => {
  const r = await analyze(fix('ts-app'), { log: quiet(), groupDir: true, groupDepth: 2 });
  assert.equal(r.graph.stats.grouped, true);
  // src/main.ts 没有更深一层目录，因此归到 src 这个节点
  const ids = r.graph.nodes.filter((n) => !n.external).map((n) => n.id).sort();
  assert.deepEqual(ids, ['src', 'src/api', 'src/db', 'src/ui', 'src/utils']);
  // 聚合后 ui → db 这条违规依赖依然可见
  const edges = r.graph.edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.ok(edges.includes('src/ui->src/db'));
});

test('maxNodes 超限时自动上卷并留下警告', async () => {
  const log = quiet();
  const r = await analyze(fix('ts-app'), { log, maxNodes: 2 });
  assert.equal(r.graph.stats.grouped, true);
  assert.ok(r.diagnostics.some((d) => d.code === 'auto-grouped'));
});
