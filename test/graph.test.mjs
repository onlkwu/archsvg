import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tarjanSCCs, buildGraph } from '../src/graph.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';

/** 用简写建邻接表，让测试意图一眼可见 */
function adj(spec) {
  const map = new Map();
  for (const [from, tos] of Object.entries(spec)) map.set(from, [...tos].sort());
  return { nodeIds: Object.keys(spec).sort(), map };
}

test('tarjanSCCs：无环图不产生环', () => {
  const { nodeIds, map } = adj({ a: ['b'], b: ['c'], c: [] });
  assert.deepEqual(tarjanSCCs(nodeIds, map), []);
});

test('tarjanSCCs：识别三节点环', () => {
  const { nodeIds, map } = adj({ a: ['b'], b: ['c'], c: ['a'] });
  assert.deepEqual(tarjanSCCs(nodeIds, map), [['a', 'b', 'c']]);
});

test('tarjanSCCs：识别自环', () => {
  const { nodeIds, map } = adj({ a: ['a'] });
  assert.deepEqual(tarjanSCCs(nodeIds, map), [['a']]);
});

test('tarjanSCCs：两个独立环互不干扰', () => {
  const { nodeIds, map } = adj({ a: ['b'], b: ['a'], c: ['d'], d: ['c'] });
  assert.deepEqual(tarjanSCCs(nodeIds, map), [['a', 'b'], ['c', 'd']]);
});

test('tarjanSCCs：深链不爆栈（迭代实现的理由）', () => {
  const n = 20000;
  const spec = {};
  for (let i = 0; i < n; i += 1) spec[`n${i}`] = i + 1 < n ? [`n${i + 1}`] : [];
  const { nodeIds, map } = adj(spec);
  assert.deepEqual(tarjanSCCs(nodeIds, map), []);
});

test('buildGraph：自环不会让环检测崩溃，且不产生自指边', async () => {
  const r = await analyzeFixture('cycle-app');
  // 同一文件自己指向自己的边在聚合/建图阶段就该消失
  assert.equal(r.graph.edges.some((e) => e.from === e.to), false);
});

test('buildGraph：自环只体现为 cycles，不体现为边', () => {
  const files = [
    { path: 'a.ts', dir: '', name: 'a.ts', bytes: 10, lines: 1, language: 'ts' },
  ];
  const resolved = [
    { kind: 'internal', from: 'a.ts', target: 'a.ts', specifier: './a', line: 1, importKind: 'static' },
  ];
  const g = buildGraph({ files, resolved });
  assert.deepEqual(g.cycles, [['a.ts']], '自环必须被识别为一组环');
  assert.equal(g.edges.length, 0, '自指边不应进入边表');
  assert.equal(g.stats.cycleCount, 1);
  assert.equal(g.stats.nodeCount, 1);
});

test('buildGraph：权重累计同一条依赖的多次引用', async () => {
  const r = await analyzeFixture('py-app');
  const edge = r.graph.edges.find(
    (e) => e.from === 'app/api/routes.py' && e.to === 'app/core/models.py',
  );
  assert.ok(edge);
  assert.equal(edge.weight, 2);
});

test('buildGraph：度数统计与边数一致', async () => {
  const r = await analyzeFixture('ts-app');
  const g = r.graph;
  const internalEdges = g.edges.filter((e) => e.kind === 'internal');
  const inSum = g.nodes.filter((n) => !n.external).reduce((s, n) => s + n.inDeg, 0);
  const outSum = g.nodes.filter((n) => !n.external).reduce((s, n) => s + n.outDeg, 0);
  assert.equal(outSum, internalEdges.length);
  assert.equal(inSum, internalEdges.length);
});

test('buildGraph：孤立节点也有统计值', async () => {
  const r = await analyzeFixture('py-app');
  const isolated = r.graph.nodes.find((n) => n.id === 'app/core/__init__.py');
  assert.ok(isolated);
  assert.equal(isolated.inDeg, 0);
  assert.equal(isolated.outDeg, 0);
  assert.ok(isolated.lines > 0);
});

test('buildGraph：目录聚合后节点行数是文件行数之和', async () => {
  const flat = await analyzeFixture('ts-app');
  const grouped = await analyzeFixture('ts-app', { groupDir: true, groupDepth: 2 });
  const dbFlat = flat.graph.nodes
    .filter((n) => n.id.startsWith('src/db/'))
    .reduce((s, n) => s + n.lines, 0);
  const dbGrouped = grouped.graph.nodes.find((n) => n.id === 'src/db');
  assert.ok(dbGrouped);
  assert.equal(dbGrouped.lines, dbFlat);
});

test('buildGraph：外部包折叠成单个节点并记录入度', async () => {
  const r = await analyzeFixture('ts-app');
  const ext = r.graph.nodes.find((n) => n.external);
  assert.ok(ext);
  assert.equal(ext.label, 'express');
  assert.equal(ext.inDeg, 1);
});
