/**
 * 鲁棒性套件 7：静态自检与语义一致性。
 *
 * 找的是"运行时不会抛错、但结果悄悄不对"的那类问题：
 * 引用了不存在的颜色常量（SVG 里变成空属性 → 黑线）、
 * 语言白名单与实现不一致、package.json 里的脚本指向不存在的命令、
 * 死代码与未使用的 import、产品代码里出现子进程或网络调用。
 *
 * 用法: node tools/stress7.mjs
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'bin', 'cli.mjs');
const work = join(tmpdir(), 'archsvg-stress7');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** 递归收集源码文件（跳过 tools：本文件自己的检查模式会污染结果） */
async function collectSources(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'out', 'docs', 'demo', 'tools'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await collectSources(p, out);
    else if (/\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

// ---------------------------------------------------------------------------
// 1) 所有 COLORS.X 引用都必须真实存在（写错会静默变成空属性 → 黑线）
// ---------------------------------------------------------------------------
{
  const themeText = await readFile(join(root, 'src', 'theme.mjs'), 'utf8');
  const paletteBlock = /export const COLORS = \{([\s\S]*?)\n\};/.exec(themeText);
  check('theme.mjs 里有 COLORS 调色板', Boolean(paletteBlock));

  const keys = new Set(
    [...(paletteBlock?.[1] ?? '').matchAll(/^\s*([A-Za-z][\w]*):/gm)].map((m) => m[1]),
  );
  check('调色板非空', keys.size >= 5, `${keys.size} 个颜色`);

  const sources = await collectSources(root);
  const bad = [];
  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/COLORS\.([A-Za-z][\w]*)/g)) {
      if (!keys.has(m[1])) bad.push(`${relative(root, file)}: COLORS.${m[1]}`);
    }
  }
  check('所有 COLORS.X 引用都存在', bad.length === 0, bad.slice(0, 5).join(', '));

  // 反过来：调色板里定义了却没人用的项，属于死代码
  const used = new Set();
  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/COLORS\.([A-Za-z][\w]*)/g)) used.add(m[1]);
  }
  const unused = [...keys].filter((k) => !used.has(k));
  check('调色板没有未使用的项', unused.length === 0, unused.join(', '));
}

// ---------------------------------------------------------------------------
// 2) 渲染出的颜色值必须是合法 hex（不能出现 undefined）
// ---------------------------------------------------------------------------
{
  const r = await cli([join(root, 'demo'), '--quiet']);
  const svg = r.stdout;
  check('SVG 里没有 undefined 属性值', !/="undefined"/.test(svg) && !/stroke=""|fill=""/.test(svg));

  const colorAttrs = [...svg.matchAll(/(?:stroke|fill|color)="([^"]*)"/g)].map((m) => m[1]);
  const invalid = colorAttrs.filter(
    (c) => c && c !== 'none' && !/^#[0-9a-fA-F]{3,8}$/.test(c) && !/^url\(#[\w-]+\)$/.test(c),
  );
  check('所有颜色属性都是合法值', invalid.length === 0, [...new Set(invalid)].slice(0, 5).join(', '));

  // 引用的 marker id 必须有对应定义
  const usedMarkers = new Set([...svg.matchAll(/url\(#([\w-]+)\)/g)].map((m) => m[1]));
  const definedMarkers = new Set([...svg.matchAll(/<marker id="([\w-]+)"/g)].map((m) => m[1]));
  const missing = [...usedMarkers].filter((m) => !definedMarkers.has(m));
  check('引用的箭头 marker 都有定义', missing.length === 0, missing.join(', '));

  // 每个 <rect>/<text> 的 x/y 都必须是数字
  const badCoord = [...svg.matchAll(/<(?:rect|text)\b[^>]*\b(x|y)="([^"]*)"/g)]
    .filter((m) => !/^-?[\d.]+$/.test(m[2]));
  check('所有坐标属性都是数字', badCoord.length === 0, JSON.stringify(badCoord.slice(0, 3)));
}

// ---------------------------------------------------------------------------
// 3) --lang 白名单必须与实现的解析器一致
// ---------------------------------------------------------------------------
{
  const langText = await readFile(join(root, 'src', 'lang.mjs'), 'utf8');
  // 语言集合写成了联合类型，形如 @typedef {'js' | 'ts' | 'py' | 'generic'} Language
  const union = /@typedef\s*\{([^}]*)\}\s*Language/.exec(langText);
  const declared = new Set(
    [...(union?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
  );
  check('lang.mjs 声明了语言集合', declared.size >= 3, [...declared].join(','));

  // CLI 的 SUPPORTED_LANGUAGES 必须和它一致，否则会出现
  // "参数通过校验但永远筛不出文件"的组合
  const cliText = await readFile(join(root, 'bin', 'cli.mjs'), 'utf8');
  const cliUnion = /SUPPORTED_LANGUAGES = new Set\(\[([^\]]*)\]\)/.exec(cliText);
  const cliDeclared = new Set([...(cliUnion?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const onlyInCli = [...cliDeclared].filter((l) => !declared.has(l));
  const onlyInLang = [...declared].filter((l) => !cliDeclared.has(l));
  check('--lang 白名单与 lang.mjs 完全一致',
    onlyInCli.length === 0 && onlyInLang.length === 0,
    `仅 CLI: ${onlyInCli.join(',')}；仅 lang.mjs: ${onlyInLang.join(',')}`);

  // 每种声明的语言都必须能真的解析出一个文件
  const langRepo = join(work, 'langs');
  await mkdir(join(langRepo, 'src'), { recursive: true });
  const samples = {
    js: ['a.js', "import { b } from './b.js';\nexport const a = b;\n"],
    ts: ['a.ts', "import { b } from './b';\nexport const a = b;\n"],
    py: ['a.py', 'import b\n'],
    generic: ['a.cpp', '#include "b.h"\n'],
  };
  for (const [, [name, body]] of Object.entries(samples)) {
    await writeFile(join(langRepo, 'src', name), body, 'utf8');
  }
  await writeFile(join(langRepo, 'src', 'b.js'), 'export const b = 1;\n', 'utf8');
  await writeFile(join(langRepo, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
  await writeFile(join(langRepo, 'src', 'b.py'), 'b = 1\n', 'utf8');
  await writeFile(join(langRepo, 'src', 'b.h'), 'int b;\n', 'utf8');

  for (const lang of declared) {
    const r = await cli([langRepo, '--lang', lang, '--json', '--quiet']);
    let nodes = -1;
    try {
      nodes = JSON.parse(r.stdout).stats.nodeCount;
    } catch {
      nodes = -1;
    }
    check(`--lang ${lang} 能筛出对应文件`, r.code === 0 && nodes > 0, `nodes=${nodes}`);
  }

  // 全部文件都在时，总节点数应为 8
  const all = await cli([langRepo, '--json', '--quiet']);
  check('不加 --lang 时四种语言都被分析', JSON.parse(all.stdout).stats.nodeCount === 8,
    `nodes=${JSON.parse(all.stdout).stats.nodeCount}`);

  // 未知语言必须被拒绝，而不是静默产出空图（回归）
  const bogus = await cli([langRepo, '--lang', 'rust', '--json', '--quiet']);
  check('未知 --lang 被拒绝（拼错一个字符不能变成静默空图）',
    bogus.code === 2, `exit=${bogus.code}`);
  check('未知 --lang 的错误信息里列出可选值',
    /可选值/.test(bogus.stderr) && /generic/.test(bogus.stderr),
    JSON.stringify(bogus.stderr.slice(0, 120)));

  // 手滑多打一个字符是最常见的输入错误
  const typo = await cli([langRepo, '--lang', 'tss', '--quiet']);
  check('--lang 拼写错误（tss）被拒绝', typo.code === 2, `exit=${typo.code}`);

  // 多值里只要有一个非法就整体拒绝
  const mixed = await cli([langRepo, '--lang', 'js,rust', '--quiet']);
  check('--lang 多值中混入非法值也被拒绝', mixed.code === 2, `exit=${mixed.code}`);

  // 合法多值正常工作
  const good = await cli([langRepo, '--lang', 'js,ts', '--json', '--quiet']);
  check('--lang 合法多值正常', good.code === 0 && JSON.parse(good.stdout).stats.nodeCount === 4,
    `nodes=${good.code === 0 ? JSON.parse(good.stdout).stats.nodeCount : 'n/a'}`);
}

// ---------------------------------------------------------------------------
// 4) package.json 里的脚本必须都能跑通
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  check('package.json 定义了脚本', Object.keys(scripts).length > 0, Object.keys(scripts).join(','));

  // 脚本里引用的每个文件都必须存在
  const referenced = new Set();
  for (const cmd of Object.values(scripts)) {
    for (const m of String(cmd).matchAll(/(?:^|\s)([\w./\\-]+\.mjs)/g)) referenced.add(m[1]);
  }
  const missing = [];
  for (const rel of referenced) {
    const exists = await readFile(join(root, rel), 'utf8').then(() => true).catch(() => false);
    if (!exists) missing.push(rel);
  }
  check('脚本引用的文件都存在', missing.length === 0, missing.join(', '));

  // npm run check 实际就是一串 `node --check`，
  // 直接在这里执行它们，而不是 spawn npm：
  // npm.cmd 必须带 shell:true，而 Node 24 的 execFile + shell:true 在 Windows 上
  // 即使命令成功也会抛 EINVAL/DEP0190，无法用来判断结果。
  const checkCmd = String(scripts.check ?? '');
  const checkTargets = [...checkCmd.matchAll(/node --check ([\w./\\-]+\.mjs)/g)].map((m) => m[1]);
  check('check 脚本里有可解析的目标', checkTargets.length > 0, `${checkTargets.length} 个文件`);

  const checkFailed = [];
  for (const target of checkTargets) {
    const r = await run(process.execPath, ['--check', target], { cwd: root, encoding: 'utf8' })
      .then(() => ({ ok: true, err: '' }))
      .catch((e) => ({ ok: false, err: String(e.stderr ?? e.message).slice(0, 160) }));
    if (!r.ok) checkFailed.push(`${target}: ${r.err.split('\n')[0]}`);
  }
  check('npm run check 的全部目标语法正确', checkFailed.length === 0, checkFailed.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
// 5) 每个 CLI 选项都必须有 help 文本
// ---------------------------------------------------------------------------
{
  const cliText = await readFile(join(root, 'bin', 'cli.mjs'), 'utf8');
  const flagBlock = /const FLAGS = \[([\s\S]*?)\n\];/.exec(cliText);
  const defs = [...(flagBlock?.[1] ?? '').matchAll(/\{ name: '([^']+)'[\s\S]*?help: '([^']*)'/g)]
    .map((m) => ({ name: m[1], help: m[2] }));
  check('所有选项都有 help 文本', defs.length > 0 && defs.every((d) => d.help.length > 0),
    defs.filter((d) => !d.help).map((d) => d.name).join(','));

  const help = await cli(['--help']);
  const missingInHelp = defs.filter((d) => !help.stdout.includes(`--${d.name}`));
  check('--help 里列出了全部选项', missingInHelp.length === 0,
    missingInHelp.map((d) => d.name).join(','));

  // 帮助里提到的默认值必须与代码一致
  const defaults = [
    ['max-nodes', /默认 (\d+)/, 400],
    ['max-files', /默认 (\d+)/, 5000],
    ['group-depth', /默认 (\d+)/, 2],
  ];
  for (const [name, re, expected] of defaults) {
    const line = help.stdout.split('\n').find((l) => l.includes(`--${name}`)) ?? '';
    const m = re.exec(line);
    check(`--${name} 的默认值在 help 里说明为 ${expected}`, m && Number(m[1]) === expected,
      JSON.stringify(line.trim()));
  }
}

// ---------------------------------------------------------------------------
// 6) 源文件里不应有遗留的调试输出
// ---------------------------------------------------------------------------
{
  const sources = await collectSources(join(root, 'src'));
  sources.push(join(root, 'bin', 'cli.mjs'));
  const offenders = [];
  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    // console.log 只允许出现在注释里
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/console\.(log|debug|dir)\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
        offenders.push(`${relative(root, file)}:${i + 1}`);
      }
    });
  }
  check('src 与 bin 里没有遗留 console.log', offenders.length === 0, offenders.join(', '));
}

// ---------------------------------------------------------------------------
// 7) 导出但从未被引用的符号（死代码信号）
// ---------------------------------------------------------------------------
{
  const sources = await collectSources(root);
  const allText = (await Promise.all(sources.map((f) => readFile(f, 'utf8')))).join('\n');
  const exportsFound = [...allText.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  const neverUsed = [];
  for (const name of new Set(exportsFound)) {
    // 至少要被 import 或在本文件里被调用一次
    const importUses = [...allText.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
    if (importUses <= 1) neverUsed.push(name);
  }
  check('没有完全无人引用的导出', neverUsed.length === 0, neverUsed.join(', '));
}

// ---------------------------------------------------------------------------
// 8) 每个 import 的具名符号都必须真的被用到
// ---------------------------------------------------------------------------
{
  // 只看产品代码。测试文件里大量出现的是"作为字符串里的示例源码"，
  // 用正则去解析会把它们当成真实 import，产生满屏假阳性。
  const sources = [...(await collectSources(join(root, 'src'))), join(root, 'bin', 'cli.mjs')];
  const unused = [];
  for (const file of sources) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        const uses = [...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
        if (uses <= 1) unused.push(`${relative(root, file)}: ${name}`);
      }
    }
  }
  check('没有未使用的 import', unused.length === 0, unused.slice(0, 6).join(', '));
}

// ---------------------------------------------------------------------------
// 9) 供应链：零外部依赖，且产品代码只 import node: 与相对路径
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const depCount =
    Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
  check('package.json 声明零依赖', depCount === 0, `${depCount} 个依赖`);

  // 逐行看 import 语句，避免被正则字面量里的 exec( 之类误伤
  const sources = [...(await collectSources(join(root, 'src'))), join(root, 'bin', 'cli.mjs')];
  const external = [];
  for (const file of sources) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const m = /^\s*import\s+[^;]*?from\s+'([^']+)'/.exec(line);
      if (!m) continue;
      const spec = m[1];
      if (!spec.startsWith('node:') && !spec.startsWith('.')) {
        external.push(`${relative(root, file)}: ${spec}`);
      }
    }
  }
  check('产品代码只 import node: 与相对路径', external.length === 0, external.slice(0, 4).join(', '));

  // 危险能力：产品代码里不应出现子进程或网络调用。
  // 要排除 `.exec(`（正则的方法）以及注释行。
  const dangerous = [];
  for (const file of sources) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (/\b(execFile|spawn|spawnSync|execSync|fork)\s*\(/.test(line)) {
        dangerous.push(`${relative(root, file)}: 子进程`);
      }
      if (/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(line)) {
        dangerous.push(`${relative(root, file)}: 网络`);
      }
    }
  }
  check('产品代码没有子进程与网络调用', dangerous.length === 0, dangerous.slice(0, 4).join(', '));

  // 元检查：SECURITY.md 里声称的保障必须真的被上面这些断言覆盖
  const security = await readFile(join(root, 'SECURITY.md'), 'utf8');
  check('SECURITY.md 说明了只读与零依赖', /只读/.test(security) && /零依赖/.test(security));
  check('SECURITY.md 列出了资源上限', /max-files/.test(security) && /max-nodes/.test(security));
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
  process.exit(1);
}
