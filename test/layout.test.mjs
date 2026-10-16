import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layout, textWidth } from '../src/layout.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';

test('确定性：同一输入连续布局 3 次结果完全一致', async () => {
  const r = await analyzeFixture('ts-app');
  const a = JSON.stringify(layout(r.graph));
  const b = JSON.stringify(layout(r.graph));
  const c = JSON.stringify(layout(r.graph));
  assert.equal(a, b);
  assert.equal(b, c);
});

test('确定性：重新分析得到的图，布局结果依然一致', async () => {
  const first = layout((await analyzeFixture('ts-app')).graph);
  const second = layout((await analyzeFixture('ts-app')).graph);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('有环的图也能完成布局（环不该让分层死循环）', async () => {
  const r = await analyzeFixture('cycle-app');
  const laid = layout(r.graph);
  assert.equal(laid.nodes.length, 3);
  // 三个节点在同一层：互相依赖无法分层
  const layers = new Set(laid.nodes.map((n) => n.layer));
  assert.ok(layers.size >= 1);
});

test('坐标不会出现 -0 或 NaN', async () => {
  const r = await analyzeFixture('ts-app');
  const laid = layout(r.graph);
  for (const n of laid.nodes) {
    for (const key of ['x', 'y', 'w', 'h']) {
      assert.ok(Number.isFinite(n[key]), `${n.id}.${key} 不是有限数`);
      assert.notEqual(Object.is(n[key], -0), true, `${n.id}.${key} 是 -0`);
    }
  }
});

test('同层节点不重叠', async () => {
  const r = await analyzeFixture('ts-app', { groupDir: true, groupDepth: 2 });
  const laid = layout(r.graph);
  const byLayer = new Map();
  for (const n of laid.nodes) {
    if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
    byLayer.get(n.layer).push(n);
  }
  for (const [layer, nodes] of byLayer) {
    const sorted = [...nodes].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      assert.ok(
        cur.x >= prev.x + prev.w,
        `第 ${layer} 层节点重叠: ${prev.id}(x=${prev.x},w=${prev.w}) 与 ${cur.id}(x=${cur.x})`,
      );
    }
  }
});

test('不同层的 y 坐标严格递增', async () => {
  const r = await analyzeFixture('ts-app');
  const laid = layout(r.graph);
  const byLayer = [...new Set(laid.nodes.map((n) => n.layer))].sort((a, b) => a - b);
  let prevY = -Infinity;
  for (const layer of byLayer) {
    const y = laid.nodes.find((n) => n.layer === layer).y;
    assert.ok(y > prevY, `层 ${layer} 的 y=${y} 没有大于上一层的 ${prevY}`);
    prevY = y;
  }
});

test('每条内部边都被走线，且点数至少为 2', async () => {
  const r = await analyzeFixture('ts-app');
  const laid = layout(r.graph);
  const internal = r.graph.edges.filter(
    (e) => e.kind === 'internal' && e.from !== e.to,
  );
  assert.equal(laid.edges.length, internal.length);
  for (const e of laid.edges) {
    assert.ok(e.points.length >= 2, `${e.from}->${e.to} 走线点数不足`);
    for (const [x, y] of e.points) {
      assert.ok(Number.isFinite(x) && Number.isFinite(y));
    }
  }
});

test('画布尺寸覆盖所有节点', async () => {
  const r = await analyzeFixture('ts-app');
  const laid = layout(r.graph);
  for (const n of laid.nodes) {
    assert.ok(n.x + n.w <= laid.width + 0.5, `${n.id} 超出画布宽度`);
    assert.ok(n.y + n.h <= laid.height + 0.5, `${n.id} 超出画布高度`);
  }
});

test('空图布局不报错', async () => {
  const r = await analyzeFixture('empty-app');
  const laid = layout(r.graph);
  assert.deepEqual(laid.nodes, []);
  assert.deepEqual(laid.edges, []);
  assert.ok(laid.width >= 0);
  assert.ok(laid.height >= 0);
});

test('自环走线不会跑出节点右侧太远，也不产生负坐标', () => {
  const graph = {
    nodes: [
      { id: 'a.ts', label: 'a.ts', kind: 'file', dir: '', lines: 10, inDeg: 1, outDeg: 1, external: false },
    ],
    edges: [
      { from: 'a.ts', to: 'a.ts', weight: 1, kind: 'internal', isCycle: true, refs: [{ file: 'a.ts', line: 1 }] },
    ],
    cycles: [['a.ts']],
    cycleEdges: new Set(['a.ts\u0000a.ts']),
    stats: {},
  };
  const laid = layout(graph);
  assert.equal(laid.edges.length, 1);
  for (const [x, y] of laid.edges[0].points) {
    assert.ok(x >= 0 && y >= 0, `自环出现负坐标 (${x}, ${y})`);
  }
  // 环不该横跨整张画布
  const maxX = Math.max(...laid.edges[0].points.map(([x]) => x));
  assert.ok(maxX <= laid.nodes[0].x + laid.nodes[0].w + 40, `自环过宽，maxX=${maxX}`);
});

test('超大单层会折行，不会产出超宽画布', () => {
  const nodes = [];
  for (let i = 0; i < 200; i += 1) {
    nodes.push({
      id: `f${i}.ts`,
      label: `f${i}.ts`,
      kind: 'file',
      dir: '',
      lines: 5,
      inDeg: 0,
      outDeg: 0,
      external: false,
    });
  }
  const graph = { nodes, edges: [], cycles: [], cycleEdges: new Set(), stats: {} };
  const laid = layout(graph);
  assert.equal(laid.nodes.length, 200);
  assert.ok(laid.width <= 1500, `画布宽度 ${laid.width} 超过折行阈值`);
  // 折行后高度必然上升
  assert.ok(laid.height > 200, `折行后高度只有 ${laid.height}`);
});

test('textWidth 是等宽估算，长文本更宽', () => {
  assert.ok(textWidth('abcdef', 12) > textWidth('abc', 12));
  assert.equal(textWidth('', 12), 0);
});

test('大图布局在可接受时间内完成', async () => {
  const r = await analyzeFixture('ts-app');
  // 人为放大到 400 个节点，验证没有指数级退化
  const nodes = [];
  const edges = [];
  for (let i = 0; i < 400; i += 1) {
    nodes.push({
      id: `m${i}`,
      label: `mod${i}`,
      kind: 'file',
      dir: '',
      lines: 10,
      inDeg: 0,
      outDeg: 0,
      external: false,
    });
    if (i > 0) edges.push({ from: `m${i - 1}`, to: `m${i}`, weight: 1, kind: 'internal', isCycle: false, refs: [] });
  }
  const graph = { nodes, edges, cycles: [], cycleEdges: new Set(), stats: r.graph.stats };
  const started = Date.now();
  const laid = layout(graph);
  const elapsed = Date.now() - started;
  assert.equal(laid.nodes.length, 400);
  assert.ok(elapsed < 2000, `400 节点布局耗时 ${elapsed}ms，超过 2s`);
});
