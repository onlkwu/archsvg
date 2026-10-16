/**
 * package.json 的 `imports` 字段（`#` 开头的仓库内别名）。
 *
 * 为什么必须支持：这是现代 Node 项目里 tsconfig paths 的等价物，
 * 而它的形态完全不同——specifier 以 `#` 开头，映射写在离文件最近的
 * package.json 里。不处理的话这些依赖会全部变成名为 `#utils` 的
 * "外部包"，图上一眼看上去像是引了个第三方库。
 *
 * `exports` 字段刻意不处理：那是包的对外出口，只有在跨包按包名导入时才
 * 需要解析，而"按包名导入"在本工具里本来就归为外部依赖。
 */

/**
 * 判断是否是 `imports` 别名写法。
 * @param {string} spec
 */
export function isPackageImportsSpecifier(spec) {
  return typeof spec === 'string' && spec.startsWith('#');
}

/**
 * 从 package.json 里取 imports 映射。
 * @param {any} json
 * @returns {Array<{pattern: string, targets: string[]}> | null}
 */
export function importsMapOf(json) {
  const imports = json?.imports;
  if (!imports || typeof imports !== 'object') return null;
  const out = [];
  for (const key of Object.keys(imports).sort()) {
    const targets = collectTargets(imports[key]);
    if (targets.length > 0) out.push({ pattern: key, targets });
  }
  return out.length > 0 ? out : null;
}

/**
 * 把一条映射值摊平成目标列表。
 *
 * Node 允许条件是嵌套对象（{"node": {...}, "default": "..."}）。
 * 这里做的是"取所有能拿到字符串的叶子并按深度优先顺序排列"，
 * 而不是精确实现 Node 的条件解析——因为对架构图来说，
 * 挑中同一个文件的不同条件分支没有区别，挑错文件的概率极低。
 *
 * @param {any} value
 * @param {number} [depth]
 * @returns {string[]}
 */
function collectTargets(value, depth = 0) {
  if (depth > 4) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectTargets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = [];
    for (const k of Object.keys(value).sort()) out.push(...collectTargets(value[k], depth + 1));
    return out;
  }
  return [];
}

/**
 * 用 imports 映射解析 `#` 别名。
 *
 * @param {string} spec 形如 `#utils/date.js` 或 `#config`
 * @param {Array<{pattern: string, targets: string[]}>} imports
 * @param {string} pkgDir imports 定义所在目录（即 package.json 所在目录，仓库内 POSIX 路径）
 * @param {(p: string) => string} normalize
 * @returns {string[]} 候选仓库内相对路径（未补后缀）
 */
export function resolvePackageImports(spec, imports, pkgDir, normalize) {
  const candidates = [];
  for (const { pattern, targets } of imports) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (spec !== pattern) continue;
      for (const t of targets) candidates.push(joinTarget(pkgDir, t, normalize));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!spec.startsWith(prefix)) continue;
    if (suffix && !spec.endsWith(suffix)) continue;
    const middle = spec.slice(prefix.length, suffix ? spec.length - suffix.length : undefined);
    for (const t of targets) {
      const filled = t.includes('*') ? t.replace('*', middle) : `${t}${middle}`;
      candidates.push(joinTarget(pkgDir, filled, normalize));
    }
  }
  return candidates;
}

/**
 * `imports` 里的目标路径是相对 package.json 所在目录的，不是相对引用方文件。
 * 这一点搞错会让深层文件里的 `#` 别名全部指向错误位置。
 */
function joinTarget(pkgDir, target, normalize) {
  const t = String(target);
  const rel = t.startsWith('./') || t.startsWith('../') ? t : `./${t}`;
  return normalize(pkgDir, rel);
}
