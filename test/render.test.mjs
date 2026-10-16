import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderSvg, escapeXml, truncate } from '../src/render-svg.mjs';
import { renderHtml } from '../src/render-html.mjs';
import { buildReport, renderText } from '../src/report.mjs';
import { layout } from '../src/layout.mjs';
import { displayWidth } from '../src/text.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';
import { checkXml } from './helpers/xml.mjs';

async function renderFor(name, opts = {}) {
  const r = await analyzeFixture(name, opts);
  const meta = {
    title: 'demo',
    subtitle: '测试用副标题',
    footnote: 'archsvg',
  };
  const rendered = renderSvg({ graph: r.graph, layout: r.layout, meta });
  return { r, rendered, meta };
}

test('渲染出的 SVG 是良构 XML', async () => {
  const { rendered } = await renderFor('ts-app');
  const res = checkXml(rendered.svg);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
});

test('有环的图渲染后依然良构', async () => {
  const { rendered } = await renderFor('cycle-app');
  const res = checkXml(rendered.svg);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
});

test('空图渲染后依然良构', async () => {
  const { rendered } = await renderFor('empty-app');
  const res = checkXml(rendered.svg);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
});

test('目录聚合的图渲染后依然良构', async () => {
  const { rendered } = await renderFor('ts-app', { groupDir: true, groupDepth: 2 });
  const res = checkXml(rendered.svg);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
});

test('渲染是确定性的：同一次分析渲染两次字节一致', async () => {
  const r = await analyzeFixture('ts-app');
  const meta = { title: 'demo' };
  const a = renderSvg({ graph: r.graph, layout: r.layout, meta }).svg;
  const b = renderSvg({ graph: r.graph, layout: r.layout, meta }).svg;
  assert.equal(a, b);
});

test('渲染不含时间戳等易变信息', async () => {
  const { rendered } = await renderFor('ts-app');
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rendered.svg), false);
  assert.equal(rendered.svg.includes('generated'), false);
});

test('escapeXml 覆盖 XML 五个保留字符', () => {
  assert.equal(escapeXml(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;');
});

test('标题与标签里的特殊字符被正确转义', async () => {
  const r = await analyzeFixture('ts-app');
  // 人为放进最恶劣的字符组合
  r.graph.nodes[0].label = `<script>alert("x&y")</script>`;
  const rendered = renderSvg({
    graph: r.graph,
    layout: r.layout,
    meta: { title: 'a & b <c>' },
  });
  assert.equal(rendered.svg.includes('<script>'), false);
  assert.ok(rendered.svg.includes('&lt;script&gt;'));
  const res = checkXml(rendered.svg);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
});

test('truncate 按估算宽度截断并加省略号', () => {
  assert.equal(truncate('abcdef', 1000, 12), 'abcdef');
  const cut = truncate('a'.repeat(100), 100, 12);
  assert.ok(cut.length < 100);
  assert.ok(cut.endsWith('…'));
});

test('truncate 与 displayWidth 把中文按两倍宽度计算', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('架构图'), 6);
  // 同样的像素预算，中文只能放下半数量的字
  const budget = 12 * 0.6 * 10;
  assert.equal(truncate('abcdefghij', budget, 12), 'abcdefghij');
  assert.ok(truncate('架构图架构图架构图', budget, 12).length < 10);
});

test('SVG 包含图例与标题', async () => {
  const { rendered } = await renderFor('ts-app');
  assert.ok(rendered.svg.includes('demo'));
  assert.ok(rendered.svg.includes('循环依赖'));
  assert.ok(rendered.svg.includes('弱依赖'));
});

test('HTML 输出包含内联 SVG 与统计面板', async () => {
  const { r, rendered, meta } = await renderFor('ts-app');
  const html = renderHtml({
    svg: rendered.svg,
    graph: r.graph,
    meta,
    width: rendered.width,
    height: rendered.height,
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<svg'));
  assert.ok(html.includes('</svg>'));
  assert.ok(html.includes('统计'));
  assert.ok(html.includes('外部包'));
});

test('HTML 在存在循环依赖时列出环', async () => {
  const { r, rendered, meta } = await renderFor('cycle-app');
  const html = renderHtml({ svg: rendered.svg, graph: r.graph, meta });
  assert.ok(html.includes('src/a.ts'));
});

test('所有几何都落在画布内（图例与折线最容易溢出）', async () => {
  for (const name of ['ts-app', 'cycle-app', 'clean-app', 'py-app', 'empty-app']) {
    const { rendered } = await renderFor(name);
    const header = /<svg[^>]*width="([\d.]+)" height="([\d.]+)"/.exec(rendered.svg);
    assert.ok(header, `${name}: 无法解析画布尺寸`);
    const width = Number(header[1]);
    const height = Number(header[2]);

    // 逐 token 扫描并累积 translate，避免用正则切割嵌套 <g> 导致误判
    const stack = [{ dx: 0, dy: 0 }];
    const points = [];
    const tokens = /<g\b([^>]*)>|<\/g>|<path\b[^>]*\bd="([^"]+)"[^>]*>/g;
    let m;
    while ((m = tokens.exec(rendered.svg)) !== null) {
      if (m[0].startsWith('</g>')) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (m[0].startsWith('<g')) {
        const t = /transform="translate\((-?[\d.]+),\s*(-?[\d.]+)\)"/.exec(m[1] || '');
        const top = stack[stack.length - 1];
        stack.push(t ? { dx: top.dx + Number(t[1]), dy: top.dy + Number(t[2]) } : { ...top });
        continue;
      }
      const cur = stack[stack.length - 1];
      for (const seg of m[2].matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
        points.push({ x: Number(seg[1]) + cur.dx, y: Number(seg[2]) + cur.dy });
      }
    }

    const bad = points.filter(
      (p) => p.x < -0.5 || p.y < -0.5 || p.x > width + 0.5 || p.y > height + 0.5,
    );
    assert.equal(
      bad.length,
      0,
      `${name}: ${bad.length} 个点越界，例如 ${JSON.stringify(bad.slice(0, 3))}（画布 ${width}x${height}）`,
    );
  }
});

test('自环也会被画出来（不能因为少见就静默丢弃）', async () => {
  const graph = {
    nodes: [
      { id: 'a.ts', label: 'a.ts', kind: 'file', dir: '', lines: 3, inDeg: 1, outDeg: 1, external: false },
      { id: 'b.ts', label: 'b.ts', kind: 'file', dir: '', lines: 3, inDeg: 0, outDeg: 1, external: false },
    ],
    edges: [
      { from: 'a.ts', to: 'a.ts', weight: 1, kind: 'internal', isCycle: true, refs: [{ file: 'a.ts', line: 1 }] },
      { from: 'a.ts', to: 'b.ts', weight: 1, kind: 'internal', isCycle: false, refs: [{ file: 'a.ts', line: 2 }] },
    ],
    cycles: [['a.ts']],
    cycleEdges: new Set(['a.ts\u0000a.ts']),
    stats: { nodeCount: 2, edgeCount: 2, externalCount: 0, cycleCount: 1, totalLines: 6, grouped: false, groupDepth: 0 },
  };
  const laid = layout(graph);
  assert.equal(laid.edges.length, 2, '自环必须出现在布局结果里');

  const rendered = renderSvg({ graph, layout: laid, meta: { title: 'self-loop' } });
  const res = checkXml(rendered.svg);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
  assert.ok(rendered.svg.includes('c0392b'), '自环应使用环的颜色');
});

test('report：结构稳定且可 JSON 序列化', async () => {
  const r = await analyzeFixture('ts-app');
  const report = buildReport({
    root: r.root,
    graph: r.graph,
    layout: r.layout,
    violations: [],
    extras: r.extras,
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.nodes.length, r.graph.nodes.length);
  assert.equal(report.edges.length, r.graph.edges.length);
  // 坐标必须带进 report，否则上层工具无法复现布局
  const node = report.nodes.find((n) => !n.external);
  assert.ok(Number.isFinite(node.x));
  const round = JSON.parse(JSON.stringify(report));
  assert.deepEqual(round, report);
});

test('report：文本摘要包含关键统计', async () => {
  const r = await analyzeFixture('cycle-app');
  const report = buildReport({ root: r.root, graph: r.graph, layout: r.layout });
  const text = renderText(report);
  assert.ok(text.includes('循环依赖'));
  assert.ok(text.includes('src/a.ts'));
});
