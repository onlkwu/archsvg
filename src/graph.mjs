/**
 * 图构建与环检测。
 *
 * 图是后续一切的唯一数据源：布局、渲染、--check 都只读这张图。
 * 因此这里必须只做"事实"的事（谁依赖谁、有几行代码），不做任何布局或样式判断。
 */

import { computeLabels } from './labels.mjs';

/**
 * @typedef {object} GraphNode
 * @property {string} id
 * @property {string} label
 * @property {'file' | 'dir' | 'external'} kind
 * @property {number} lines
 * @property {number} inDeg
 * @property {number} outDeg
 * @property {boolean} external
 * @property {string} [dir]
 */

/**
 * @typedef {object} GraphEdge
 * @property {string} from
 * @property {string} to
 * @property {number} weight
 * @property {'internal' | 'external'} kind
 * @property {boolean} isCycle
 * @property {Array<{file: string, line: number}>} refs
 */

/**
 * @typedef {object} Graph
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {string[][]} cycles  每个元素是一组互相可达的节点 id
 * @property {Set<string>} cycleEdges  "from\u0000to"
 * @property {object} stats
 */

/**
 * Tarjan 强连通分量，迭代实现。
 *
 * 为什么必须迭代：真实仓库的依赖链可能很深，递归版会爆栈——
 * 而爆栈发生在用户机器上，是最难排查的一类故障。
 *
 * @param {string[]} nodeIds 已排序的节点 id 列表
 * @param {Map<string, string[]>} adj 已排序的邻接表
 * @returns {string[][]} 只包含 size >= 2 的环，以及带自环的单节点；按发现顺序输出
 */
export function tarjanSCCs(nodeIds, adj) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  /** @type {string[][]} */
  const sccs = [];

  for (const start of nodeIds) {
    if (index.has(start)) continue;

    /** @type {Array<{node: string, i: number}>} */
    const work = [{ node: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbours = adj.get(frame.node) || [];

      if (frame.i < neighbours.length) {
        const next = neighbours[frame.i];
        frame.i += 1;

        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, i: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        }
        continue;
      }

      // 这个节点的邻居都走完了
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }

      if (low.get(frame.node) === index.get(frame.node)) {
        const comp = [];
        for (;;) {
          const n = stack.pop();
          onStack.delete(n);
          comp.push(n);
          if (n === frame.node) break;
        }
        const selfLoop = comp.length === 1 && (adj.get(comp[0]) || []).includes(comp[0]);
        if (comp.length > 1 || selfLoop) {
          comp.sort();
          sccs.push(comp);
        }
      }
    }
  }

  return sccs;
}

/**
 * 用已解析的引用构建图。
 *
 * @param {object} input
 * @param {import('./scan.mjs').FileInfo[]} input.files
 * @param {Array<import('./resolve.mjs').Resolved>} input.resolved
 * @param {object} [opts]
 * @param {boolean} [opts.groupDir]        按目录聚合
 * @param {number} [opts.groupDepth]       聚合深度
 * @param {Map<string, string>} [opts.moduleIdOf]  文件 → 聚合节点 id
 * @returns {Graph}
 */
export function buildGraph({ files, resolved }, opts = {}) {
  const groupDir = Boolean(opts.groupDir);
  const depth = opts.groupDepth ?? 2;

  /** @type {Map<string, GraphNode>} */
  const nodes = new Map();

  const dirPathOf = (relPath, d) => {
    const parts = relPath.split('/');
    parts.pop();
    return parts.slice(0, d).join('/') || '.';
  };

  const idOf = (relPath) => (groupDir ? dirPathOf(relPath, depth) : relPath);

  // 建节点
  for (const f of files) {
    const id = idOf(f.path);
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        label: groupDir ? id : f.name,
        kind: groupDir ? 'dir' : 'file',
        dir: dirOf(f.path),
        lines: 0,
        inDeg: 0,
        outDeg: 0,
        external: false,
      };
      nodes.set(id, node);
    }
    node.lines += f.lines;
  }

  /** @type {Map<string, GraphEdge>} */
  const edgeMap = new Map();
  /** @type {Map<string, {count: number, refs: Array<{file: string, line: number}>}>} */
  const externalUse = new Map();

  const edgeKey = (a, b) => `${a}\u0000${b}`;

  const addRef = (from, to, ref) => {
    const key = edgeKey(from, to);
    let e = edgeMap.get(key);
    if (!e) {
      e = { from, to, weight: 0, kind: 'internal', isCycle: false, refs: [] };
      edgeMap.set(key, e);
    }
    e.weight += 1;
    // refs 去重并按行号排序：--check 要靠它报出准确位置
    if (!e.refs.some((r) => r.file === ref.file && r.line === ref.line)) {
      e.refs.push({ file: ref.file, line: ref.line });
      e.refs.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));
    }
  };

  for (const r of resolved) {
    if (r.kind === 'internal') {
      const from = idOf(r.from);
      const to = idOf(r.target);
      // 目录聚合后自己指自己：没有信息量，连环也不算
      if (from === to && groupDir) continue;
      addRef(from, to, { file: r.from, line: r.line });
    } else if (r.kind === 'external' && r.pkg) {
      const id = `external:${r.pkg}`;
      if (!externalUse.has(id)) externalUse.set(id, { count: 0, refs: [] });
      const rec = externalUse.get(id);
      rec.count += 1;
      if (rec.refs.length < 5) rec.refs.push({ file: r.from, line: r.line });
    }
  }

  // 环检测（在内部节点上做）
  const internalIds = [...nodes.keys()].sort();
  /** @type {Map<string, string[]>} */
  const adj = new Map();
  for (const id of internalIds) adj.set(id, []);
  for (const e of edgeMap.values()) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
  }
  for (const list of adj.values()) list.sort();

  const cycles = tarjanSCCs(internalIds, adj);
  const cycleEdges = new Set();
  const cycleNodes = new Set();
  for (const comp of cycles) {
    for (const id of comp) cycleNodes.add(id);
    if (comp.length === 1) {
      cycleEdges.add(edgeKey(comp[0], comp[0]));
    } else {
      const inComp = new Set(comp);
      for (const e of edgeMap.values()) {
        if (inComp.has(e.from) && inComp.has(e.to)) cycleEdges.add(edgeKey(e.from, e.to));
      }
    }
  }

  /** @type {GraphEdge[]} */
  // 自指边不进最终边表：它不表达结构关系，画出来只会干扰阅读。
  // 它已经通过 cycles 完成了自己的使命。
  const edges = [...edgeMap.values()].filter((e) => e.from !== e.to);
  for (const e of edges) {
    if (cycleEdges.has(edgeKey(e.from, e.to))) e.isCycle = true;
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (from) from.outDeg += 1;
    if (to) to.inDeg += 1;
  }

  // 外部依赖节点：默认折叠成一个粗节点，避免图上全是 npm 包名
  for (const [id, rec] of [...externalUse.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const pkg = id.slice('external:'.length);
    nodes.set(id, {
      id,
      label: pkg,
      kind: 'external',
      dir: '',
      lines: 0,
      inDeg: rec.count,
      outDeg: 0,
      external: true,
    });
  }

  edges.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1));

  const nodeList = [...nodes.values()];

  // 显示名：重名的文件补上足够长的目录前缀。
  // 不做这一步，一张图上会出现七个 index.ts，图就没法看了。
  // 按目录聚合时标签本来就是目录名，不参与。
  if (!groupDir) {
    const labels = computeLabels(nodeList.filter((n) => !n.external).map((n) => n.id));
    for (const n of nodeList) {
      const label = labels.get(n.id);
      if (label) n.label = label;
    }
  }

  return {
    nodes: nodeList,
    edges,
    cycles,
    cycleEdges,
    stats: {
      nodeCount: nodeList.filter((n) => !n.external).length,
      externalCount: nodeList.filter((n) => n.external).length,
      edgeCount: edges.length,
      cycleCount: cycles.length,
      cycleNodeCount: cycleNodes.size,
      totalLines: nodeList.reduce((s, n) => s + n.lines, 0),
      grouped: groupDir,
      groupDepth: groupDir ? depth : 0,
    },
  };
}

function dirOf(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '' : relPath.slice(0, i);
}
