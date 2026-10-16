/**
 * 依赖提取：把源码文本变成"引用了哪个模块"的裸事实。
 *
 * 策略是保守正则而非 AST，理由：
 * - 依赖是零，不需要解析器生态
 * - 架构图能容忍漏一条边，不能容忍假边
 * - 正则的失败模式可预测（漏报），AST 的失败模式是崩溃（各种语法变体）
 */

/** @typedef {{ relPath: string, specifier: string, line: number, kind: string }} ImportRef */

/**
 * 提取一个文件里的所有依赖引用。
 *
 * @param {string} relPath 仓库内 POSIX 相对路径（用于定位和诊断）
 * @param {import('./lang.mjs').Language} language
 * @param {string} text
 * @returns {ImportRef[]}
 */
export function parseImports(relPath, language, text) {
  let src = text;
  if (language === 'py') src = collapseParenImports(stripPythonDocstrings(src));
  // C/C++ 的块注释里常有示例 include，先剥掉
  if (language === 'generic') src = stripBlockComments(src);

  /** @type {ImportRef[]} */
  const refs = [];
  const seen = new Set();

  const push = (specifier, index, kind) => {
    if (!specifier) return;
    const line = lineAt(src, index);
    const key = `${line}|${specifier}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ relPath, specifier, line, kind });
  };

  const patterns = language === 'py' ? PY_PATTERNS : language === 'generic' ? GENERIC_PATTERNS : JS_PATTERNS;

  if (language === 'py') {
    const [fromPattern, importPattern] = PY_PATTERNS;

    fromPattern.re.lastIndex = 0;
    let m;
    while ((m = fromPattern.re.exec(src)) !== null) {
      const pkg = m[2];
      // from pkg import a, b
      // 同时产出 pkg 与 pkg.a：a 既可能是子模块也可能是变量，交给解析层用索引判定。
      // 只产出两者之一会分别造成"漏掉真实模块"或"漏掉包本身"。
      push(pkg, m.index, 'from-import');
      for (const item of splitTopLevel(m[3] || '')) {
        const name = item.split(/\s+as\s+/)[0].trim();
        if (!name || name === '*') continue;
        push(joinPyPath(pkg, name), m.index, 'from-import');
      }
      if (m.index === fromPattern.re.lastIndex) fromPattern.re.lastIndex += 1;
    }

    importPattern.re.lastIndex = 0;
    let m2;
    while ((m2 = importPattern.re.exec(src)) !== null) {
      // import a.b as c, d  →  摊平成 a.b、d
      for (const item of splitTopLevel(m2[2] || '')) {
        const name = item.split(/\s+as\s+/)[0].trim();
        if (name) push(name, m2.index, 'import');
      }
      if (m2.index === importPattern.re.lastIndex) importPattern.re.lastIndex += 1;
    }

    refs.sort((a, b) => a.line - b.line || (a.specifier < b.specifier ? -1 : 1));
    return refs;
  }

  for (const { re, kind, group } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      push(m[group], m.index, kind);
      // 零宽匹配保护
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }

  refs.sort((a, b) => a.line - b.line || (a.specifier < b.specifier ? -1 : 1));
  return refs;
}

/** from 后面的包路径 + import 的名字。相对前缀必须保留。 */
function joinPyPath(pkg, name) {
  if (/^\.+$/.test(pkg)) return `${pkg}${name}`;
  return `${pkg}.${name}`;
}

/** 按逗号切分 import 列表，忽略空项 */
function splitTopLevel(s) {
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 1-based 行号 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// ---------------------------------------------------------------------------
// JS / TS
// ---------------------------------------------------------------------------

const JS_PATTERNS = [
  // import X, { a as b } from 'mod'  /  import 'mod'
  // import type { T } from 'mod'
  {
    kind: 'static',
    group: 1,
    re: /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  },
  // export { a } from 'mod'  /  export * from 'mod'
  {
    kind: 're-export',
    group: 1,
    re: /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]/g,
  },
  // import('mod')
  {
    kind: 'dynamic',
    group: 1,
    re: /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  },
  // require('mod')
  {
    kind: 'require',
    group: 1,
    re: /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  },
];

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_PATTERNS = [
  // from .a.b import c   /   from ..pkg import x,y   /   from . import sub   /   from mod import *
  // 分组号约定（两条规则一致）：1 保留、2 包路径、3 名字列表。
  // 名字列表用 (?:[^\n]*\S) 是为了让它非空且不被末尾空白吞掉——
  // 写成 ([^\n]*?) 加 [ \t]*$ 会匹配空串，静默丢掉所有名字。
  {
    kind: 'from-import',
    group: 2,
    re: /^[ \t]*from[ \t]+()(\.{0,3}[A-Za-z_][\w.]*|\.+)[ \t]+import[ \t]+(?:([^\n]*\S))[ \t]*$/gm,
  },
  // import a.b as c, d
  {
    kind: 'import',
    group: 2,
    re: /^[ \t]*import[ \t]+()([A-Za-z_][\w.]*(?:[ \t]+as[ \t]+[A-Za-z_]\w*)?(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*(?:[ \t]+as[ \t]+[A-Za-z_]\w*)?)*)[ \t]*$/gm,
  },
];

// ---------------------------------------------------------------------------
// C / C++ / 其他 generic
// ---------------------------------------------------------------------------

const GENERIC_PATTERNS = [
  // #include "local.h" —— 引号形式永远相对当前文件查找（C 标准行为）
  {
    kind: 'include',
    group: 1,
    re: /^[ \t]*#[ \t]*include[ \t]*"([^"\n]+)"/gm,
  },
  // #include <stdio.h> —— 尖括号形式走系统头文件搜索路径，不算项目内依赖
  {
    kind: 'system-include',
    group: 1,
    re: /^[ \t]*#[ \t]*include[ \t]*<([^>\n]+)>/gm,
  },
];

// ---------------------------------------------------------------------------
// 预处理工具
// ---------------------------------------------------------------------------

/**
 * 剥掉 Python 的独立三引号字符串（docstring / 长字符串）。
 *
 * 为什么必须做：Python 文档里最常见的写法就是一段示例代码，
 * 里面往往有 import。不剥掉就会凭空造出依赖边——
 * 这是本工具最容易出现的假边来源。
 *
 * 只处理"独占一行"的三引号块，避免误伤 a = """...""" 这类单行赋值。
 */
export function stripPythonDocstrings(text) {
  const lines = text.split('\n');
  const out = [];
  let open = null;

  for (const rawLine of lines) {
    const line = rawLine;
    if (open) {
      const idx = line.indexOf(open);
      if (idx === -1) {
        out.push(''); // 保持行号不变
        continue;
      }
      out.push('');
      open = null;
      continue;
    }

    const trimmed = line.trimStart();
    const m = /^(?:[rRbBuU]{0,2})("""|''')/.exec(trimmed);
    if (m) {
      const delim = m[1];
      const rest = trimmed.slice(m[0].length);
      if (rest.includes(delim)) {
        // 单行闭合，且不在最前面？仍然安全：把整行清空会丢真实代码，所以只清空引号内内容
        out.push(line.replace(/("""|''')[\s\S]*?\1/, '$1$1'));
      } else {
        out.push('');
        open = delim;
      }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** 剥掉 /* ... *\/ 块注释；保留行结构以便行号正确 */
export function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 把括号形式的 import 折成一行：
 *
 *   from .api import (
 *       routes,
 *       helpers,
 *   )
 *   →  from .api import routes, helpers,
 *
 * 折行后必须补回等量的换行，否则后面所有 import 的行号都会偏移，
 * 而 --check 报出的行号是给人点开文件用的，错一行就等于指错地方。
 */
export function collapseParenImports(text) {
  const re = /^([ \t]*(?:from[ \t]+[.\w]+[ \t]+)?import[ \t]*)\(([\s\S]*?)\)/gm;
  return text.replace(re, (match, head, body) => {
    const lineCount = match.split('\n').length;
    const joined = `${head}${body.split('\n').map((s) => s.trim()).join(' ')} `;
    return joined + '\n'.repeat(lineCount - 1);
  });
}
