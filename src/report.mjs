/**
 * JSON 输出。
 *
 * 为什么坚持要有它：测试要断言"结构化诊断"而不是渲染文本，
 * 否则每改一次视觉就要重写一遍快照。另外 CI/上层工具也需要可编程的接口。
 */

export const REPORT_SCHEMA_VERSION = 1;

/**
 * 从 extras 里剔除不确定的字段。
 *
 * `durationMs` 每次运行都不同，如果进 JSON，`--json` 就永远无法逐字节比较，
 * 而这恰恰是这个输出格式最有价值的用途（CI 里对比两次提交的结构变化）。
 * 耗时改由 --timing 单独打到 stderr。
 */
function stableExtras(extras) {
  if (!extras) return {};
  const { durationMs, ...rest } = extras;
  return rest;
}

/**
 * @param {object} input
 * @param {string} input.root
 * @param {import('./graph.mjs').Graph} input.graph
 * @param {ReturnType<import('./layout.mjs').layout>} input.layout
 * @param {import('./rules.mjs').Violation[]} [input.violations]
 * @param {object} [input.extras] 附加统计（扫描计数等）
 */
export function buildReport({ root, graph, layout, violations, extras }) {
  const positioned = new Map(layout.nodes.map((n) => [n.id, n]));

  const nodes = graph.nodes
    .map((n) => {
      const p = positioned.get(n.id);
      return {
        id: n.id,
        label: n.label,
        kind: n.kind,
        dir: n.dir,
        lines: n.lines,
        inDeg: n.inDeg,
        outDeg: n.outDeg,
        external: n.external,
        ...(p ? { x: p.x, y: p.y, w: p.w, h: p.h, layer: p.layer } : {}),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const edges = graph.edges
    .map((e) => ({
      from: e.from,
      to: e.to,
      weight: e.weight,
      kind: e.kind,
      isCycle: e.isCycle,
      refs: e.refs,
    }))
    .sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1));

  const cycles = graph.cycles.map((c) => [...c].sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    root,
    stats: { ...graph.stats, ...stableExtras(extras) },
    nodes,
    edges,
    cycles,
    violations: violations ?? [],
  };
}

/** 给人看的文本摘要；--check 的输出也走这里 */
export function renderText(report, opts = {}) {
  const lines = [];
  const s = report.stats;

  lines.push(`模块 ${s.nodeCount} 个 · 依赖 ${s.edgeCount} 条 · 外部包 ${s.externalCount} 个`);
  // 耗时只出现在这里（stderr），不进 JSON：否则 --json 无法逐字节比较
  if (typeof opts.durationMs === 'number') lines.push(`分析耗时 ${opts.durationMs}ms`);
  if (s.grouped) lines.push(`已按目录聚合（深度 ${s.groupDepth}），因为节点数超过上限`);
  if (s.cycleCount > 0) {
    lines.push(`发现 ${s.cycleCount} 组循环依赖：`);
    report.cycles.slice(0, 5).forEach((c) => {
      lines.push(`  - ${c.join(' → ')}`);
    });
    if (report.cycles.length > 5) lines.push(`  ...另有 ${report.cycles.length - 5} 组`);
  }

  const violations = report.violations || [];
  if (violations.length > 0) {
    lines.push('');
    lines.push(`架构违规 ${violations.length} 处：`);
    for (const v of violations) {
      for (const ref of v.refs) {
        lines.push(`  ✗ ${ref.file}:${ref.line}  ${v.message}  [${v.ruleId}]`);
      }
    }
  } else if (opts.expectCheck) {
    lines.push('架构检查通过：未发现违规');
  }

  if (report.stats.skipped && report.stats.skipped.total > 0) {
    lines.push(`已跳过 ${report.stats.skipped.total} 个文件（依赖/构建产物/非源码）`);
  }

  return `${lines.join('\n')}\n`;
}
