/**
 * SVG 渲染。
 *
 * 手写字符串而不是引 d3/elkjs，原因有三：
 * 1. 零依赖是"npx 一下就能用"的前提
 * 2. 输出体积小得多（README 里嵌一张 100KB 的图是不可接受的）
 * 3. 能完全控制确定性——同一个图必须产出同一串字节
 *
 * 审美靠纪律：所有尺寸、颜色、间距都从 theme.mjs 取，这里不出现魔法数字。
 */

import { COLORS, FONT, GAP, LEGEND_FONT_SIZE, LEGEND_ITEMS, NODE, round } from './theme.mjs';
import { displayWidth, textWidth } from './text.mjs';

/** XML 文本/属性转义。少转义一个 & 就会让整张图在浏览器里炸掉。 */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 按估算宽度截断标签。等宽字体下用显示宽度近似即可，且必须确定。
 * @param {string} text
 * @param {number} maxWidth
 * @param {number} fontSize
 */
export function truncate(text, maxWidth, fontSize) {
  const s = String(text);
  const perChar = fontSize * 0.6;
  const maxWidths = Math.max(3, Math.floor(maxWidth / perChar));
  let acc = 0;
  let out = '';
  for (const ch of s) {
    const w = displayWidth(ch);
    if (acc + w > maxWidths) return `${out}…`;
    acc += w;
    out += ch;
  }
  return out;
}

export { textWidth };

/**
 * @typedef {object} RenderMeta
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} [footnote]
 * @property {string} [groupLabel]
 */

/**
 * @param {object} input
 * @param {import('./graph.mjs').Graph} input.graph
 * @param {ReturnType<import('./layout.mjs').layout>} input.layout
 * @param {RenderMeta} input.meta
 * @param {boolean} [input.dark] 预留：深色主题
 * @returns {{ svg: string, width: number, height: number, nodes: Map<string, {x: number, y: number, w: number, h: number}> }}
 */
export function renderSvg({ graph, layout, meta }) {
  const titleBlock = GAP.titleBlock;
  const legendBlock = GAP.legendBlock;
  const margin = GAP.margin;

  const offsetX = margin;
  const offsetY = margin + titleBlock;

  // 画布必须同时容得下图和底部图例。图例比图宽是很常见的情况
  // （图只有 3 个节点、图例却有 5 个条目），这时要把画布撑开而不是裁掉图例。
  const innerWidth = Math.max(layout.contentWidth ?? layout.width, 320, legendWidth() + margin);
  const width = round(innerWidth + margin * 2);
  const height = round(layout.height + titleBlock + legendBlock + margin * 2);
  // 内容在更宽的画布上居中，否则会贴着左边看起来像被裁过
  const centerShift = round((innerWidth - (layout.contentWidth ?? layout.width)) / 2);
  const layoutOffsetX = offsetX + Math.max(0, centerShift);

  /** @type {Map<string, {x: number, y: number, w: number, h: number}>} */
  const boxes = new Map();
  for (const n of layout.nodes) {
    boxes.set(n.id, {
      x: round(n.x + layoutOffsetX),
      y: round(n.y + offsetY),
      w: n.w,
      h: n.h,
    });
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // 预先摊平环内节点，避免每个节点都对 cycles 做一次线性扫描
  const cycleNodes = new Set();
  for (const c of graph.cycles) for (const id of c) cycleNodes.add(id);

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escapeXml(FONT)}" role="img" aria-label="${escapeXml(meta.title)} 架构图">`,
  );
  out.push(`<title>${escapeXml(meta.title)} 模块依赖图</title>`);
  out.push(`<desc>${escapeXml(meta.subtitle || '')}</desc>`);

  // 箭头标记
  out.push('<defs>');
  out.push(arrowMarker('arrow', COLORS.line));
  out.push(arrowMarker('arrowCycle', COLORS.cycle));
  out.push('</defs>');

  out.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${COLORS.bg}"/>`);

  // ---- 标题区 ----
  out.push(
    `<text x="${margin}" y="${margin + 22}" font-size="16" font-weight="600" fill="${COLORS.ink}">${escapeXml(
      meta.title,
    )}</text>`,
  );
  if (meta.subtitle) {
    out.push(
      `<text x="${margin}" y="${margin + 42}" font-size="11" fill="${COLORS.inkSoft}">${escapeXml(
        meta.subtitle,
      )}</text>`,
    );
  }

  // ---- 边（先画，让节点盖住线头）----
  // 布局只产出几何信息，引用明细（文件:行号）仍在 graph.edges 上，这里按 from→to 关联回来
  const graphEdges = new Map(graph.edges.map((e) => [`${e.from}\u0000${e.to}`, e]));

  out.push('<g stroke-linejoin="round" fill="none">');
  for (const e of layout.edges) {
    const d = e.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x + layoutOffsetX)} ${round(y + offsetY)}`).join(' ');
    const stroke = e.isCycle ? COLORS.cycle : COLORS.line;
    const dash = e.isCycle ? '' : e.weight > 2 ? '' : ' stroke-dasharray="4 3"';
    const marker = e.isCycle ? 'arrowCycle' : 'arrow';
    const strokeWidth = e.isCycle ? 1.6 : e.weight > 2 ? 1.6 : 1;
    const refs = graphEdges.get(`${e.from}\u0000${e.to}`)?.refs ?? [];
    const title = edgeTitle(e, refs, byId);
    out.push(
      `<path d="${d}" stroke="${stroke}" stroke-width="${strokeWidth}"${dash} marker-end="url(#${marker})"><title>${escapeXml(
        title,
      )}</title></path>`,
    );
  }
  out.push('</g>');

  // ---- 节点 ----
  out.push('<g>');
  for (const p of layout.nodes) {
    const box = boxes.get(p.id);
    const node = byId.get(p.id);
    if (!box || !node) continue;

    const isCycle = cycleNodes.has(p.id);
    const fill = isCycle ? COLORS.cycleSoft : COLORS.nodeFill;
    const stroke = isCycle ? COLORS.cycle : COLORS.nodeStroke;

    const label = truncate(node.label, box.w - NODE.paddingX * 2, NODE.fontSize);
    const sub = node.lines > 0 ? `${node.lines} 行` : '';

    out.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${NODE.radius}" fill="${fill}" stroke="${stroke}" stroke-width="1"><title>${escapeXml(
        nodeTooltip(node),
      )}</title></rect>`,
    );

    const cx = round(box.x + box.w / 2);
    const textY = sub ? round(box.y + box.h / 2 - 2) : round(box.y + box.h / 2 + 4);
    out.push(
      `<text x="${cx}" y="${textY}" font-size="${NODE.fontSize}" fill="${COLORS.nodeText}" text-anchor="middle">${escapeXml(
        label,
      )}</text>`,
    );
    if (sub) {
      out.push(
        `<text x="${cx}" y="${round(box.y + box.h / 2 + 13)}" font-size="${NODE.subFontSize}" fill="${
          COLORS.nodeSub
        }" text-anchor="middle">${escapeXml(sub)}</text>`,
      );
    }
  }
  out.push('</g>');

  // ---- 图例 ----
  const legendY = round(height - margin - 6);
  out.push(renderLegend(margin, legendY));

  // ---- 脚注 ----
  // 外部包在图上是折叠节点、不参与布局，所以它们的名字在 SVG 里本来完全不可见。
  // 但"我依赖了哪些第三方"是这张图最有价值的信息之一，
  // 因此把被依赖最多的几个包列在右下角。
  const externalNote = topExternalNote(graph);
  const footnoteParts = [externalNote, meta.footnote].filter(Boolean);
  if (footnoteParts.length > 0) {
    out.push(
      `<text x="${round(width - margin)}" y="${legendY}" font-size="10" fill="${COLORS.inkSoft}" text-anchor="end">${escapeXml(
        footnoteParts.join(' · '),
      )}</text>`,
    );
  }

  out.push('</svg>');
  return { svg: out.join('\n'), width, height, nodes: boxes };
}

/**
 * 把被依赖最多的前几个外部包拼成一句说明。
 * 按 (被依赖次数, 名称) 排序，保证同一输入产出同一串文本。
 */
function topExternalNote(graph) {
  const external = graph.nodes.filter((n) => n.external);
  if (external.length === 0) return '';

  const sorted = [...external].sort((a, b) =>
    b.inDeg === a.inDeg ? (a.label < b.label ? -1 : 1) : b.inDeg - a.inDeg,
  );
  const shown = sorted.slice(0, 4).map((n) => n.label);
  const more = sorted.length > shown.length ? ` 等 ${sorted.length} 个` : '';
  return `外部依赖 ${shown.join(', ')}${more}`;
}

function arrowMarker(id, color) {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${color}"/></marker>`;
}

function nodeTooltip(node) {
  const parts = [node.label];
  if (node.kind === 'dir') parts.push('模块目录');
  if (node.lines > 0) parts.push(`${node.lines} 行`);
  parts.push(`入度 ${node.inDeg} / 出度 ${node.outDeg}`);
  return parts.join(' · ');
}

/**
 * 边的悬停说明：谁指向谁、引用了几次、具体在哪几行。
 * refs 来自 graph.edges，不是布局产物——布局只关心几何。
 */
function edgeTitle(edge, refs, byId) {
  const from = byId.get(edge.from)?.label ?? edge.from;
  const to = byId.get(edge.to)?.label ?? edge.to;
  const list = Array.isArray(refs) ? refs : [];
  const shown = list.slice(0, 3).map((r) => `${r.file}:${r.line}`).join(', ');
  const more = list.length > 3 ? ` 等 ${list.length} 处` : '';
  return `${from} → ${to}（${edge.weight} 次）${shown ? `\n${shown}${more}` : ''}`;
}

/**
 * 图例的总宽度（像素）。
 * 布局层用它来保证画布不会比图例还窄。
 */
export function legendWidth() {
  return LEGEND_ITEMS.reduce(
    (sum, item) => sum + 21 + displayWidth(item.label) * LEGEND_FONT_SIZE * 0.6 + 20,
    0,
  );
}

/**
 * 图例：小图元 + 文字，宽度按显示宽度估算。
 * 没有图例的架构图读者只能靠猜，这是"看起来专业"最便宜的加分项。
 */
function renderLegend(x, y) {
  const out = [`<g transform="translate(${round(x)},${round(y)})">`];
  let cx = 0;
  for (const item of LEGEND_ITEMS) {
    if (item.kind === 'box') {
      out.push(
        `<rect x="${cx}" y="-9" width="14" height="10" rx="2" fill="${item.fill}" stroke="${item.color}" stroke-width="1"/>`,
      );
    } else {
      const dash = item.kind === 'dash' ? ' stroke-dasharray="4 3"' : '';
      out.push(
        `<path d="M${cx} -4 H${cx + 16}" stroke="${item.color}" stroke-width="1.4"${dash} fill="none"/>`,
      );
    }
    out.push(
      `<text x="${cx + 21}" y="-1" font-size="${LEGEND_FONT_SIZE}" fill="${COLORS.inkSoft}">${escapeXml(item.label)}</text>`,
    );
    // 显示宽度而不是字符数：中文标签按字符数算会把图例挤成一团
    cx += 21 + displayWidth(item.label) * LEGEND_FONT_SIZE * 0.6 + 20;
  }
  out.push('</g>');
  return out.join('\n');
}
