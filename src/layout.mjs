/**
 * 确定性分层布局（Sugiyama 风格的简化版）。
 *
 * 硬要求：同一输入必须产出字节级一致的坐标。
 * 因此本文件里所有集合遍历都显式排序，所有比较函数最后一定回落到 id 字典序，
 * 所有坐标都经过 theme.round 量化。任何一个"随手 sort 一下"都可能破坏这个性质。
 *
 * 不使用力导向布局：它看起来更"有机"，但同一仓库每次跑位置都不同，
 * 导致每次提交的 SVG diff 面目全非——这是它能进 CI 的前提被破坏。
 */

import { GAP, NODE, round } from './theme.mjs';
import { textWidth } from './text.mjs';
import { tarjanSCCs } from './graph.mjs';

/**
 * @typedef {object} PositionedNode
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} layer
 */

/**
 * @typedef {object} RoutedEdge
 * @property {string} from
 * @property {string} to
 * @property {'internal' | 'external'} kind
 * @property {boolean} isCycle
 * @property {number} weight
 * @property {Array<[number, number]>} points
 */

/**
 * @param {import('./graph.mjs').Graph} graph
 * @param {object} [opts]
 * @param {number} [opts.iterations] 中位数法迭代轮数
 * @returns {{ nodes: PositionedNode[], edges: RoutedEdge[], width: number, height: number }}
 */
export function layout(graph, opts = {}) {
  const iterations = opts.iterations ?? 4;

  const internal = graph.nodes.filter((n) => !n.external);
  const internals = new Map(internal.map((n) => [n.id, n]));

  const internalEdges = graph.edges.filter(
    (e) => e.kind === 'internal' && internals.has(e.from) && internals.has(e.to),
  );

  const nodeIds = [...internals.keys()].sort();

  // 1) 缩点：同一 SCC 作为布局单元，避免环让分层无法收敛
  const adj = new Map(nodeIds.map((id) => [id, []]));
  for (const e of internalEdges) adj.get(e.from)?.push(e.to);
  for (const list of adj.values()) list.sort();

  const sccs = tarjanSCCs(nodeIds, adj);
  const compOf = new Map();
  const comps = [];
  for (const comp of sccs) {
    const members = [...comp].sort();
    comps.push({ id: '', members, key: members[0] });
    for (const m of members) compOf.set(m, members[0]);
  }
  for (const id of nodeIds) {
    if (compOf.has(id)) continue;
    comps.push({ id: '', members: [id], key: id });
    compOf.set(id, id);
  }
  // 让组件顺序也确定：按最小成员 id 排序后统一编号
  comps.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  comps.forEach((c, i) => {
    c.id = `c${i}`;
    for (const m of c.members) compOf.set(m, c.id);
  });
  const compById = new Map(comps.map((c) => [c.id, c]));

  // 2) 缩点后的 DAG
  const cAdj = new Map(comps.map((c) => [c.id, []]));
  const cPred = new Map(comps.map((c) => [c.id, []]));
  for (const comp of comps) {
    const seen = new Set();
    for (const member of comp.members) {
      for (const to of adj.get(member) || []) {
        const target = compOf.get(to);
        if (target === comp.id || seen.has(target)) continue;
        seen.add(target);
        cAdj.get(comp.id).push(target);
      }
    }
    cAdj.get(comp.id).sort();
  }
  for (const [from, list] of cAdj) {
    for (const to of list) cPred.get(to).push(from);
  }
  for (const list of cPred.values()) list.sort();

  // 3) 最长路径分层
  const indeg = new Map(comps.map((c) => [c.id, cPred.get(c.id).length]));
  const layerOfComp = new Map(comps.map((c) => [c.id, 0]));
  const queue = comps.filter((c) => indeg.get(c.id) === 0).map((c) => c.id).sort();
  const remaining = new Map(indeg);
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    for (const next of cAdj.get(cur)) {
      layerOfComp.set(next, Math.max(layerOfComp.get(next), layerOfComp.get(cur) + 1));
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }

  // 4) 层内节点（把组件展开成真实节点）
  //
  // 翻转分层：让依赖箭头朝下。
  // 最长路径法得到的是"从入口往叶子"的深度，画出来箭头朝上，与所有人
  // "上层依赖下层"的阅读直觉相反。最省事又最稳的做法是在这里整体镜像，
  // 而不是再跑一遍反图分层——反图分层的同层顺序可能不同，会让相邻关系错乱。
  const maxLayer = comps.reduce((m, c) => Math.max(m, layerOfComp.get(c.id)), 0);
  /** @type {Map<number, string[]>} */
  const layers = new Map();
  for (const c of comps) {
    const layer = maxLayer - layerOfComp.get(c.id);
    layerOfComp.set(c.id, layer);
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(...c.members);
  }
  const layerKeys = [...layers.keys()].sort((a, b) => a - b);
  for (const k of layerKeys) layers.get(k).sort();

  // 邻居表（用真实节点，跨环的边也参与排序，视觉上更顺）
  const preds = new Map(nodeIds.map((id) => [id, []]));
  const succs = new Map(nodeIds.map((id) => [id, []]));
  for (const e of internalEdges) {
    if (e.from === e.to) continue;
    succs.get(e.from)?.push(e.to);
    preds.get(e.to)?.push(e.from);
  }
  for (const m of [preds, succs]) for (const list of m.values()) list.sort();

  const posIn = new Map();
  const reindex = () => {
    for (const k of layerKeys) {
      layers.get(k).forEach((id, i) => posIn.set(id, i));
    }
  };
  reindex();

  // 5) 中位数法减少交叉
  for (let it = 0; it < iterations; it += 1) {
    const downward = it % 2 === 0;
    const order = downward ? layerKeys : [...layerKeys].reverse();
    for (const k of order) {
      const ref = downward ? preds : succs;
      const list = layers.get(k);
      const medians = new Map();
      for (const id of list) {
        const positions = ref
          .get(id)
          .map((n) => posIn.get(n))
          .filter((v) => typeof v === 'number')
          .sort((a, b) => a - b);
        medians.set(id, median(positions));
      }
      list.sort((a, b) => {
        const ma = medians.get(a);
        const mb = medians.get(b);
        if (ma !== mb) return ma - mb;
        // tie-break 必须确定：先按上一层位置，再按 id
        const pa = posIn.get(a) ?? 0;
        const pb = posIn.get(b) ?? 0;
        if (pa !== pb) return pa - pb;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      reindex();
    }
  }

  // 6) 贪心消除相邻交换能减少的交叉（固定轮数 + 规模上限，保证确定性与可预测耗时）
  const GREEDY_MAX_LAYER = 48;
  for (let pass = 0; pass < 2; pass += 1) {
    for (const k of layerKeys) {
      const list = layers.get(k);
      if (list.length < 2 || list.length > GREEDY_MAX_LAYER) continue;
      const predSlots = list.map((id) =>
        (preds.get(id) || []).map((p) => posIn.get(p)).filter((v) => typeof v === 'number'),
      );
      let improved = true;
      let guard = 0;
      while (improved && guard < list.length * 2) {
        improved = false;
        guard += 1;
        for (let i = 0; i + 1 < list.length; i += 1) {
          const before = countCrossings(predSlots);
          [list[i], list[i + 1]] = [list[i + 1], list[i]];
          [predSlots[i], predSlots[i + 1]] = [predSlots[i + 1], predSlots[i]];
          const after = countCrossings(predSlots);
          if (after < before) {
            improved = true;
          } else {
            [list[i], list[i + 1]] = [list[i + 1], list[i]];
            [predSlots[i], predSlots[i + 1]] = [predSlots[i + 1], predSlots[i]];
          }
        }
      }
      reindex();
    }
  }

  // 7) 尺寸与坐标
  const sized = new Map();
  for (const id of nodeIds) {
    const node = internals.get(id);
    sized.set(id, measureNode(node));
  }

  // 换行阈值：一个层里塞进几百个孤立文件会得到一张 5000px 宽的图，
  // 在 README 里等于不可读。超过上限就把该层折成网格。
  // 只对"节点很多"的层生效，正常的分层结构不会被影响。
  const maxRowWidth = opts.maxWidth ?? 1400;
  const minWrapCount = 6;

  /** 每层实际占用的行高（可能要放好几行节点） */
  const layerHeights = new Map();
  /** @type {Map<number, Array<Array<{id: string, w: number, h: number}>>>} */
  const rowsOfLayer = new Map();

  for (const k of layerKeys) {
    const list = layers.get(k);
    const total = list.reduce((sum, id, i) => sum + sized.get(id).w + (i > 0 ? GAP.node : 0), 0);
    const shouldWrap = list.length >= minWrapCount && total > maxRowWidth;

    /** @type {Array<Array<{id: string, w: number, h: number}>>} */
    const rows = [];
    if (!shouldWrap) {
      rows.push(list.map((id) => ({ id, ...sized.get(id) })));
    } else {
      let current = [];
      let used = 0;
      for (const id of list) {
        const size = sized.get(id);
        const add = current.length > 0 ? size.w + GAP.node : size.w;
        if (current.length > 0 && used + add > maxRowWidth) {
          rows.push(current);
          current = [];
          used = 0;
        }
        current.push({ id, ...size });
        used += current.length > 1 ? size.w + GAP.node : size.w;
      }
      if (current.length > 0) rows.push(current);
    }

    rowsOfLayer.set(k, rows);
    const h = rows.reduce(
      (sum, row, i) => sum + Math.max(...row.map((n) => n.h)) + (i > 0 ? GAP.node : 0),
      0,
    );
    layerHeights.set(k, h);
  }

  const widest = Math.max(
    1,
    ...[...rowsOfLayer.values()].flatMap((rows) =>
      rows.map((row) => row.reduce((sum, n, i) => sum + n.w + (i > 0 ? GAP.node : 0), 0)),
    ),
  );

  /** @type {PositionedNode[]} */
  const positioned = [];
  // 自环画在节点上方，会超出节点上边界若干像素，整体下移给它留位置
  const hasSelfLoop = internalEdges.some((e) => e.from === e.to);
  let cursorY = hasSelfLoop ? SELF_LOOP_LIFT : 0;
  for (const k of layerKeys) {
    const rows = rowsOfLayer.get(k);
    let rowY = cursorY;
    for (const row of rows) {
      const total = row.reduce((sum, n, i) => sum + n.w + (i > 0 ? GAP.node : 0), 0);
      let x = (widest - total) / 2;
      for (const n of row) {
        positioned.push({ id: n.id, x: round(x), y: round(rowY), w: round(n.w), h: round(n.h), layer: k });
        x += n.w + GAP.node;
      }
      rowY += Math.max(...row.map((n) => n.h)) + GAP.node;
    }
    cursorY += layerHeights.get(k) + GAP.layer;
  }

  const posById = new Map(positioned.map((p) => [p.id, p]));
  const height = positioned.reduce((m, p) => Math.max(m, p.y + p.h), 0);
  const contentWidth = widest;
  // 画布至少要放得下底部图例，否则图例会溢出画布被裁掉一截
  const width = Math.max(contentWidth, opts.minWidth ?? 0);

  // 8) 走线：正交折线，同层对之间的多条边按序号错开
  const sortedEdges = [...internalEdges].sort((a, b) =>
    a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1,
  );

  const usedSlots = new Map();
  /** @type {RoutedEdge[]} */
  const routed = [];
  for (const e of sortedEdges) {
    const a = posById.get(e.from);
    const b = posById.get(e.to);
    if (!a || !b) continue;

    const slotKey = `${a.layer}\u0000${b.layer}`;
    const slot = usedSlots.get(slotKey) || 0;
    usedSlots.set(slotKey, slot + 1);

    routed.push({
      from: e.from,
      to: e.to,
      kind: e.kind,
      isCycle: e.isCycle,
      weight: e.weight,
      points: route(a, b, slot),
    });
  }

  return { nodes: positioned, edges: routed, width, contentWidth, height };
}

/** 中位数：偶数个取中间两个的均值 */
function median(sorted) {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 估算文字宽度（等宽字体）。
 * 用估算而不是真实测量：真实测量需要 canvas，会引入非确定性。
 * 复用 text.mjs 的实现，保证与渲染层用同一套标准。
 */
export { textWidth };

/** 节点尺寸由可见内容决定，再按行数做轻微加成 */
function measureNode(node) {
  const label = String(node.label);
  const sub = node.lines > 0 ? `${node.lines} 行` : '';
  const labelW = textWidth(label, NODE.fontSize);
  const subW = textWidth(sub, NODE.subFontSize);
  const w = clamp(Math.max(labelW, subW) + NODE.paddingX * 2, NODE.minWidth, NODE.maxWidth);
  const h = clamp(NODE.paddingY * 2 + NODE.fontSize + (sub ? NODE.subFontSize + 4 : 0), NODE.minHeight, NODE.maxHeight);
  return { w, h };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 统计一组"上一层位置"序列产生的交叉数。
 * 输入是每层节点按当前顺序排列的前驱槽位，序列内部已排序，
 * 于是交叉数等于所有前驱对之间逆序对的个数。
 */
function countCrossings(predSlots) {
  const items = [];
  predSlots.forEach((slots, x) => {
    for (const y of slots) items.push([y, x]);
  });
  let crossings = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const [a1, b1] = items[i];
      const [a2, b2] = items[j];
      if ((a1 - a2) * (b1 - b2) < 0) crossings += 1;
    }
  }
  return crossings;
}

/**
 * 自环向上绕出的高度。布局需要为它预留空间，否则会被裁掉。
 */
const SELF_LOOP_LIFT = 20;

/**
 * 正交折线走线。
 *
 * 三种情况分开处理，因为它们的最优形状完全不同：
 *   - 自环：从节点右侧绕一圈，节点内部没有出口
 *   - 同层（环被压缩在同一层）：走节点下方的浅弧，避免横穿节点
 *   - 跨层：标准的三段折线，同层对之间的多条边按 slot 错开
 *
 * @param {PositionedNode} a
 * @param {PositionedNode} b
 * @param {number} slot 同层对之间的序号，用于错开
 * @returns {Array<[number, number]>}
 */
function route(a, b, slot) {
  if (a.id === b.id) {
    // 自环：从顶边出去绕一圈。刻意走"上方"而不是右侧——
    // 同层邻居通常在右侧，走右侧会被邻居节点盖住，等于没画。
    const loop = SELF_LOOP_LIFT - 4;
    const x1 = round(a.x + a.w * 0.3);
    const x2 = round(a.x + a.w * 0.7);
    const yTop = round(a.y);
    const yOut = round(Math.max(0, a.y - loop));
    return [
      [x1, yTop],
      [x1, yOut],
      [x2, yOut],
      [x2, yTop],
    ];
  }

  if (a.layer === b.layer) {
    // 同层：走下方浅弧。同一层对之间可能有多条边（双向依赖很常见），
    // 必须按 slot 叠开，否则两条边会画在同一条线上看起来像一条。
    const y = round(
      Math.max(a.y, b.y) + Math.max(a.h, b.h) + 20 + (slot % 4) * 14,
    );
    const left = a.x < b.x ? a : b;
    const right = a.x < b.x ? b : a;
    const x1 = round(left.x + left.w / 2);
    const x2 = round(right.x + right.w / 2);
    return [
      [x1, round(left.y + left.h)],
      [x1, y],
      [x2, y],
      [x2, round(right.y + right.h)],
    ];
  }

  const offset = ((slot % 5) - 2) * 6;
  const x1 = round(a.x + a.w / 2 + offset);
  const y1 = round(a.y + a.h);
  const x2 = round(b.x + b.w / 2 + offset);
  const y2 = round(b.y);
  if (x1 === x2) return [[x1, y1], [x2, y2]];
  const midY = round((y1 + y2) / 2);
  return [
    [x1, y1],
    [x1, midY],
    [x2, midY],
    [x2, y2],
  ];
}
