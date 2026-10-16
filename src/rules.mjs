/**
 * 架构规则：把"图"变成"可以拦住 PR 的检查"。
 *
 * 纯画图工具会停在几百星；能报违规、能进 CI，才会被长期使用。
 * 规则文件刻意保持极简（JSON，不是 DSL）——规则越容易写，越有人愿意加。
 */

import { readFile } from 'node:fs/promises';

export const RULES_SCHEMA_VERSION = 1;

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {boolean} forbidden
 * @property {string} message
 */

/**
 * @typedef {object} Violation
 * @property {string} ruleId
 * @property {string} from
 * @property {string} to
 * @property {string} message
 * @property {Array<{file: string, line: number}>} refs
 * @property {number} count
 */

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

/**
 * 自实现 glob，只支持 ** * ?，避免为一个小功能引依赖。
 *
 * 最容易踩的两个坑：
 *
 * 1. `src/ui/**` 必须匹配 `src/ui/page.ts`。如果朴素地把 `**` 展开成
 *    `(?:.*\/)?`，正则会变成 `src\/ui\/(?:.*\/)?`，多出来的那个斜杠
 *    要求路径里必须有第二层目录，于是最顶层文件反而不匹配。
 *    所以 `**` 前面的斜杠要一起吃掉。
 *
 * 2. `./src/ui/**` 与 `src/ui/**` 必须等价。用户在编辑器里复制路径
 *    常常带 `./`，不归一化的话规则会静默失效——规则失效比规则报错更危险，
 *    因为用户会以为架构被守住了。
 *
 * @param {string} pattern
 */
export function compileGlob(pattern) {
  let p = String(pattern).replace(/\\/g, '/').replace(/\/+$/, '');
  // 去掉一个或多个 ./ 前缀
  while (p.startsWith('./')) p = p.slice(2);

  let out = '';

  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        // 吃掉紧随其后的斜杠，让 ** 能代表"零层或多层目录"
        if (p[i + 1] === '/') i += 1;
        // 同时吃掉前面刚写进去的斜杠
        if (out.endsWith('/')) out = out.slice(0, -1);
        out += '(?:/.*)?';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }

  // 目录型 pattern（`src/db`）应当匹配其下所有内容
  out += '(?:/.*)?';
  return new RegExp(`^${out}$`);
}

/**
 * @param {string} filePath
 * @param {RegExp} re
 */
export function matchesGlob(filePath, re) {
  return re.test(String(filePath).replace(/\\/g, '/'));
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath
 * @returns {Promise<{ schemaVersion: number, rules: Rule[] }>}
 */
export async function loadRules(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    const e = new Error(`无法读取规则文件: ${filePath} (${err.message})`);
    e.code = 'RULES_READ_FAILED';
    throw e;
  }

  // 去掉 UTF-8 BOM。Windows 上用记事本或 PowerShell 存 JSON 很容易带上它，
  // 而 JSON.parse 把 BOM 当非法字符——报出来的错是
  // "Unexpected token in JSON at position 0"，用户完全看不出是编码问题。
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const cleaned = hasBom ? text.slice(1) : text;

  let json;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    const hint = hasBom ? '（文件带 UTF-8 BOM，已尝试忽略）' : '';
    const e = new Error(`规则文件不是合法 JSON: ${filePath} (${err.message})${hint}`);
    e.code = 'RULES_PARSE_FAILED';
    throw e;
  }

  return validateRules(json, filePath);
}

/**
 * 校验规则文件。宁可在这里啰嗦，也不要让一条写错的规则静默失效——
 * 用户会以为架构被守住了，其实没有。
 *
 * @param {any} json
 * @param {string} [source]
 * @returns {{ schemaVersion: number, rules: Rule[] }}
 */
export function validateRules(json, source = '<inline>') {
  const fail = (msg) => {
    const e = new Error(`规则文件无效 (${source}): ${msg}`);
    e.code = 'RULES_INVALID';
    throw e;
  };

  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('顶层必须是对象');
  if (json.schemaVersion !== RULES_SCHEMA_VERSION) {
    fail(`schemaVersion 必须是 ${RULES_SCHEMA_VERSION}，实际是 ${JSON.stringify(json.schemaVersion)}`);
  }
  if (!Array.isArray(json.rules)) fail('rules 必须是数组');

  const seen = new Set();
  /** @type {Rule[]} */
  const rules = [];
  json.rules.forEach((raw, i) => {
    const at = `rules[${i}]`;
    if (!raw || typeof raw !== 'object') fail(`${at} 必须是对象`);
    for (const key of ['id', 'from', 'to', 'message']) {
      if (typeof raw[key] !== 'string' || raw[key].length === 0) fail(`${at}.${key} 必须是非空字符串`);
    }
    if (raw.forbidden !== true) {
      fail(`${at}.forbidden 必须显式写 true（目前只实现了"禁止型"规则）`);
    }
    if (seen.has(raw.id)) fail(`${at}.id 重复: ${raw.id}`);
    seen.add(raw.id);
    rules.push({
      id: raw.id,
      from: raw.from,
      to: raw.to,
      forbidden: true,
      message: raw.message,
    });
  });

  return { schemaVersion: RULES_SCHEMA_VERSION, rules };
}

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

/**
 * 在图与引用明细上执行规则检查。
 *
 * 关键：违规要报到"文件:行号"级别。只报"ui 依赖了 db"没有可操作性，
 * 报出 src/ui/Button.ts:3 才能直接点开改。
 *
 * @param {object} input
 * @param {import('./scan.mjs').FileInfo[]} input.files
 * @param {Array<import('./resolve.mjs').Resolved>} input.resolved
 * @param {Rule[]} rules
 * @returns {Violation[]}
 */
export function checkRules({ resolved }, rules) {
  /** @type {Violation[]} */
  const violations = [];

  for (const rule of rules) {
    const fromRe = compileGlob(rule.from);
    const toRe = compileGlob(rule.to);

    /** @type {Map<string, {refs: Array<{file: string, line: number}>, count: number}>} */
    const byPair = new Map();

    for (const r of resolved) {
      if (r.kind !== 'internal') continue;
      if (!matchesGlob(r.from, fromRe)) continue;
      if (!matchesGlob(r.target, toRe)) continue;
      if (r.from === r.target) continue;

      if (!byPair.has(r.from)) byPair.set(r.from, { refs: [], count: 0 });
      const rec = byPair.get(r.from);
      rec.count += 1;
      if (!rec.refs.some((x) => x.file === r.from && x.line === r.line)) {
        rec.refs.push({ file: r.from, line: r.line });
      }
    }

    for (const [from, rec] of [...byPair.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      rec.refs.sort((a, b) => a.line - b.line);
      violations.push({
        ruleId: rule.id,
        from,
        to: rule.to,
        message: rule.message,
        refs: rec.refs,
        count: rec.count,
      });
    }
  }

  violations.sort((a, b) =>
    a.from === b.from ? (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) : a.from < b.from ? -1 : 1,
  );
  return violations;
}
