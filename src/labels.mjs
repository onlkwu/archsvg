/**
 * 节点显示名的选择。
 *
 * 动机来自一个真实的可用性问题：一张图上出现七个 index.ts、五个 utils.ts 时，
 * 图就没法看了。解决办法是只对"重名"的节点补上足够长的目录前缀，
 * 补到能区分开为止——不重名的文件仍然是干净的文件名。
 *
 * 单独成模块是因为"最短唯一后缀"这件事有边界情况（完全同路径、单段路径），
 * 值得单独测。
 */

/**
 * 找出能区分 `path` 与 `others` 的最短路径后缀。
 *
 * @param {string} path 形如 "src/ui/page.ts"
 * @param {Set<string>} others 其他节点的路径集合（不含自己）
 * @returns {string}
 */
export function shortestUniqueSuffix(path, others) {
  if (others.size === 0) return path;

  const segs = String(path).split('/');
  // 从最后一段开始，逐段往前加，直到不再与别人重复
  for (let take = 1; take < segs.length; take += 1) {
    const candidate = segs.slice(segs.length - take).join('/');
    let clash = false;
    for (const other of others) {
      const oSegs = other.split('/');
      if (oSegs.slice(oSegs.length - take).join('/') === candidate) {
        clash = true;
        break;
      }
    }
    if (!clash) return candidate;
  }
  // 连全路径都一样（理论上不该发生），返回全路径
  return path;
}

/**
 * 为一批路径算出显示名。
 *
 * 复杂度：只对"文件名重复"的路径做展开，绝大多数节点直接返回文件名，
 * 所以大仓库里这一步几乎不花时间。
 *
 * @param {string[]} paths
 * @returns {Map<string, string>} 路径 → 显示名
 */
export function computeLabels(paths) {
  /** @type {Map<string, number>} */
  const basenameCount = new Map();
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    basenameCount.set(base, (basenameCount.get(base) || 0) + 1);
  }

  const labels = new Map();
  // 先把不重名的直接定下来，重名的再互相比较
  const duplicates = [];
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if ((basenameCount.get(base) || 0) === 1) {
      labels.set(p, base);
    } else {
      duplicates.push(p);
    }
  }

  for (const p of duplicates) {
    // 只与同样重名的路径比较：不重名的那些文件名不同，不可能造成冲突
    const others = new Set(duplicates.filter((x) => x !== p));
    labels.set(p, shortestUniqueSuffix(p, others));
  }
  return labels;
}
