/**
 * 设计系统常量。
 *
 * 所有视觉参数集中在这里，渲染层不许出现魔法数字——
 * 这是让输出"看起来是设计过的"而不是"随手调的"的唯一办法。
 */

export const NODE = {
  radius: 6,
  paddingX: 10,
  paddingY: 8,
  minWidth: 90,
  maxWidth: 220,
  minHeight: 34,
  maxHeight: 84,
  fontSize: 12,
  subFontSize: 10,
};

/** 布局间距（4 的倍数，保持网格感） */
export const GAP = {
  layer: 88, // 层与层的垂直距离
  node: 20, // 同层节点水平间距
  margin: 40, // 画布外边距
  titleBlock: 64, // 标题区高度
  legendBlock: 44, // 图例区高度
};

/**
 * 调色板。
 *
 * 只保留真正被渲染用到的颜色。留着"以后可能要用"的颜色槽看似无害，
 * 实际是两个坑：一是改主题时容易漏改，二是读者无法判断哪个是当前生效的。
 * 需要新颜色时再加。
 *
 * 语义：ink/inkSoft 是文字，line 是弱依赖线，node* 是节点中性色，
 * cycle* 是环内元素，bg 是画布。
 */
export const COLORS = {
  bg: '#ffffff',
  ink: '#1f2933',
  inkSoft: '#7b8794',
  line: '#cbd2d9',
  nodeFill: '#ffffff',
  nodeStroke: '#9aa5b1',
  nodeText: '#1f2933',
  nodeSub: '#7b8794',
  cycle: '#c0392b',
  cycleSoft: '#fbeae8',
};

export const FONT =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** 固定小数位，保证同一输入产出字节级一致的 SVG */
export function round(v, digits = 1) {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  // 避免出现 "-0"
  return r === 0 ? 0 : r;
}

export const LEGEND_FONT_SIZE = 10;

/**
 * 图例条目。
 *
 * 定义在这里而不是渲染层，是因为布局层需要提前知道图例占多宽——
 * 图例比图还宽时，画布必须让出空间，否则图例会被裁掉一截。
 * 这类"内容溢出画布"的 bug 在 CSS 里看不出来，只能靠这里的度量避免。
 */
export const LEGEND_ITEMS = [
  { kind: 'box', label: '模块', color: COLORS.nodeStroke, fill: COLORS.nodeFill },
  { kind: 'box', label: '循环依赖', color: COLORS.cycle, fill: COLORS.cycleSoft },
  { kind: 'line', label: '强依赖', color: COLORS.line },
  { kind: 'dash', label: '弱依赖（≤2 次）', color: COLORS.line },
  { kind: 'line', label: '环内依赖', color: COLORS.cycle },
];

