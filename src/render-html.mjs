/**
 * 单文件 HTML 输出。
 *
 * 存在意义：SVG 适合嵌 README，但"能下载、能全屏、能贴给别人"需要 HTML。
 * 刻意不引任何前端框架——产出物必须是一个可以随便丢进聊天窗口的文件。
 */

import { COLORS, FONT } from './theme.mjs';
import { escapeXml } from './render-svg.mjs';

/**
 * @param {object} input
 * @param {string} input.svg
 * @param {object} input.graph
 * @param {{ title: string, subtitle?: string, footnote?: string }} input.meta
 * @param {number} [input.width]
 * @param {number} [input.height]
 */
export function renderHtml({ svg, graph, meta, width, height }) {
  const s = graph.stats;
  const cycles = graph.cycles
    .slice(0, 8)
    .map((c) => `<li><code>${escapeXml(c.join(' → '))}</code></li>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeXml(meta.title)} — 架构图</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 24px;
    background: #f5f7fa; color: ${COLORS.ink};
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  header { max-width: 1200px; margin: 0 auto 16px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  .sub { color: ${COLORS.inkSoft}; font-size: 12px; }
  .card {
    max-width: 1200px; margin: 0 auto; padding: 16px;
    background: #fff; border: 1px solid #e1e7ec; border-radius: 10px;
    overflow: auto;
  }
  .card svg { max-width: 100%; height: auto; display: block; }
  .panels { max-width: 1200px; margin: 16px auto 0; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .panel { background: #fff; border: 1px solid #e1e7ec; border-radius: 10px; padding: 14px 16px; }
  .panel h2 { font-size: 13px; margin: 0 0 8px; font-weight: 600; color: ${COLORS.inkSoft}; text-transform: uppercase; letter-spacing: .04em; }
  .panel ul { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.8; }
  code { font-family: ${FONT}; font-size: 11px; }
  body > footer { max-width: 1200px; margin: 20px auto 0; color: ${COLORS.inkSoft}; font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>${escapeXml(meta.title)}</h1>
  <span class="sub">${escapeXml(meta.subtitle || '')}</span>
</header>

<div class="card">
${svg}
</div>

<div class="panels">
  <div class="panel">
    <h2>统计</h2>
    <ul>
      <li>模块：${s.nodeCount}</li>
      <li>依赖边：${s.edgeCount}</li>
      <li>外部包：${s.externalCount}</li>
      <li>循环依赖：${s.cycleCount}</li>
      <li>代码行数：${s.totalLines}</li>
${s.grouped ? `      <li>聚合：按目录深度 ${s.groupDepth}（节点数超限）</li>\n` : ''}    </ul>
  </div>
  <div class="panel">
    <h2>循环依赖</h2>
    ${cycles ? `<ul>${cycles}</ul>` : `<p class="sub" style="margin:0">未发现循环依赖</p>`}
  </div>
  <div class="panel">
    <h2>说明</h2>
    <ul>
      <li>节点大小 ≈ 代码行数</li>
      <li>线宽 = 依赖次数</li>
      <li>红色 = 环内依赖</li>
      <li>悬停节点/边可看明细</li>
    </ul>
  </div>
</div>

<footer>由 archsvg 生成 · 画布 ${width ?? '?'}×${height ?? '?'}</footer>
</body>
</html>
`;
}
