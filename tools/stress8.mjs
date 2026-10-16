/**
 * 鲁棒性套件 8：HTML 注入面、CLI 错误路径、产物矩阵。
 *
 * HTML 是本项目里唯一一个"会被人直接打开"的产物，它的注入面比 SVG 大：
 * 内联 SVG、多个面板、模板字符串拼接。这里往标题/文件名/规则消息里塞
 * 恶意载荷，检查转义与标签配对；另外覆盖错误路径会不会留下半个文件、
 * 以及空仓库/单文件仓库在三种输出格式下是否都能出结果。
 *
 * 用法: node tools/stress8.mjs
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'bin', 'cli.mjs');
const work = join(tmpdir(), 'archsvg-stress8');

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
      maxBuffer: 128 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const mk = (p) => mkdir(p, { recursive: true });
const crashed = (r) =>
  ![0, 1, 2].includes(r.code) || /TypeError:|ReferenceError:|UnhandledPromiseRejection/.test(r.stderr);

await rm(work, { recursive: true, force: true });
await mk(work);

// ---------------------------------------------------------------------------
// 1) HTML 注入面：把恶意内容塞进文件名、标题、规则消息
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'inject');
  // 文件名本身无法包含 < > 或引号以外的 HTML 元字符，所以主要靠 --title 和规则消息
  await mk(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'a&b.ts'), "import { c } from './c';\nexport const v = c;\n", 'utf8');
  await writeFile(join(repo, 'src', 'c.ts'), 'export const c = 1;\n', 'utf8');

  const evilTitle = `</h1><script>alert('xss')</script><h1>` + '"\'' + '&<>';
  const html = await cli([repo, '--format', 'html', '--title', evilTitle, '--quiet']);
  check('HTML：含注入载荷的标题不崩', !crashed(html) && html.code === 0, `exit=${html.code}`);

  const out = html.stdout;
  // 关键：不能出现真正可执行的 <script> 标签
  const scripts = [...out.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  check('HTML：没有可执行的 <script> 标签', scripts.length === 0,
    scripts.map((m) => m[0].slice(0, 60)).join(' | '));

  // 载荷必须以转义形式出现
  check('HTML：注入载荷被转义', out.includes('&lt;script&gt;'), '应出现 &lt;script&gt;');

  // 标签配对：粗略统计 h1 的数量必须是 1 对
  const h1Open = (out.match(/<h1>/g) || []).length;
  const h1Close = (out.match(/<\/h1>/g) || []).length;
  check('HTML：标题标签配对平衡（没有被载荷拆开）', h1Open === 1 && h1Close === 1,
    `h1 open=${h1Open}, close=${h1Close}`);

  // title 标签内容也要是转义的
  const titleTag = /<title>([\s\S]*?)<\/title>/.exec(out);
  check('HTML：<title> 内容被转义', titleTag && !titleTag[1].includes('<script'),
    JSON.stringify(titleTag?.[1]?.slice(0, 60)));
}

// ---------------------------------------------------------------------------
// 2) HTML：规则消息里的注入载荷不能逃逸到面板里
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'inject2');
  await mk(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'x.ts'), "import { y } from './y';\nexport const v = y;\n", 'utf8');
  await writeFile(join(repo, 'src', 'y.ts'), 'export const y = 1;\n', 'utf8');

  const rules = join(work, 'evil-rules.json');
  await writeFile(rules, JSON.stringify({
    schemaVersion: 1,
    rules: [{
      id: 'evil',
      from: 'src/**',
      to: 'src/**',
      forbidden: true,
      message: '"><script>alert(1)</script>',
    }],
  }), 'utf8');

  const html = await cli([repo, '--check', '--rules', rules, '--format', 'html', '--quiet']);
  check('HTML + --check：不崩', !crashed(html), `exit=${html.code}`);

  // stderr 是纯文本，消息应原样出现（便于排查），但不该带出 HTML 结构
  const scriptsInStdout = (html.stdout.match(/<script\b/gi) || []).length;
  check('HTML + --check：输出里没有 script 标签', scriptsInStdout === 0,
    `${scriptsInStdout} 个`);
}

// ---------------------------------------------------------------------------
// 3) HTML：SVG 被内联后仍然良构
// ---------------------------------------------------------------------------
{
  const { checkXml } = await import('../test/helpers/xml.mjs');
  const repo = join(root, 'demo');
  const html = await cli([repo, '--format', 'html', '--quiet']);
  const svg = /<svg[\s\S]*<\/svg>/.exec(html.stdout);
  check('HTML：能提取到内联 SVG', Boolean(svg));
  const res = checkXml(svg[0]);
  check('HTML：内联 SVG 良构', res.ok, res.ok ? '' : `${res.error} @${res.index}`);

  // HTML 自身的标签配对：统计几个关键标签
  for (const tag of ['html', 'head', 'body', 'div', 'footer']) {
    const open = (html.stdout.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
    const close = (html.stdout.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    check(`HTML：<${tag}> 标签配对`, open === close, `open=${open}, close=${close}`);
  }

  // 不能引用任何外部资源（单文件自洽）
  const external = [...html.stdout.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  check('HTML：没有外部资源引用', external.length === 0, external.slice(0, 3).join(', '));
}

// ---------------------------------------------------------------------------
// 4) HTML：真实 HTML 解析器视角下的结构完整性
// ---------------------------------------------------------------------------
{
  // 不用浏览器，只做"标签栈"级别的检查：任意位置的嵌套必须闭合
  const repo = join(root, 'demo');
  const html = (await cli([repo, '--format', 'html', '--quiet'])).stdout;

  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const stack = [];
  let broken = null;
  const tokens = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tokens.exec(html)) !== null) {
    const [, closing, name, , selfClose] = m;
    const tag = name.toLowerCase();
    // SVG 内部自成体系，交给 checkXml 管
    if (tag === 'svg') {
      const end = html.indexOf('</svg>', m.index);
      tokens.lastIndex = end === -1 ? html.length : end + 6;
      continue;
    }
    if (voidTags.has(tag) || selfClose === '/') continue;
    if (closing) {
      const top = stack.pop();
      if (top !== tag && !broken) broken = `期望 </${top}>，实际 </${tag}>`;
    } else {
      stack.push(tag);
    }
  }
  check('HTML：标签嵌套结构完整', broken === null && stack.length === 0,
    broken ?? (stack.length ? `未闭合: ${stack.join(',')}` : ''));
}

// ---------------------------------------------------------------------------
// 5) CLI 错误路径：失败时错误信息必须可读，且不留下半个文件
// ---------------------------------------------------------------------------
{
  // 只读目录：写入必须失败并且是干净的 exit 2
  const roDir = join(work, 'readonly-out');
  await mk(roDir);
  const target = join(roDir, 'x.svg');

  const okRun = await cli([join(root, 'demo'), '--out', target, '--quiet']);
  check('正常写入到可写目录', okRun.code === 0 && (await readFile(target, 'utf8')).startsWith('<svg'));

  // 二次写入到"路径中有一段是文件"的位置，模拟 ENOENT
  const blocked = join(target, 'nested', 'y.svg');
  const bad = await cli([join(root, 'demo'), '--out', blocked, '--quiet']);
  check('输出路径非法：exit 2 且不崩', bad.code === 2 && !crashed(bad), `exit=${bad.code}`);
  check('输出路径非法：错误信息可读（提到路径或系统错误）',
    /ENOTDIR|ENOENT|EEXIST|EISDIR|EPERM|EACCES|错误/.test(bad.stderr),
    JSON.stringify(bad.stderr.slice(0, 120)));
}

// ---------------------------------------------------------------------------
// 6) --check 缺少 --rules：报错但不应留下空文件
// ---------------------------------------------------------------------------
{
  const outFile = join(work, 'should-not-exist.svg');
  const r = await cli([join(root, 'demo'), '--check', '--out', outFile, '--quiet']);
  check('--check 缺 --rules：exit 2', r.code === 2, `exit=${r.code}`);
  const exists = await readFile(outFile, 'utf8').then(() => true).catch(() => false);
  check('--check 缺 --rules：不留下输出文件', exists === false, String(exists));
}

// ---------------------------------------------------------------------------
// 7) report/renderText 对残缺 report 的鲁棒性
// ---------------------------------------------------------------------------
{
  const { renderText, buildReport } = await import('../src/report.mjs');
  const base = { stats: { nodeCount: 0, edgeCount: 0, externalCount: 0, cycleCount: 0, grouped: false } };

  const cases = [
    ['缺失 violations', { ...base }],
    ['缺失 cycles', { ...base, violations: [] }],
    ['stats 缺字段', { stats: {}, cycles: [], violations: [] }],
    ['violations 是 undefined', { ...base, cycles: [], violations: undefined }],
    ['nodes 里有 external 节点', {
      ...base,
      stats: { ...base.stats, nodeCount: 1, externalCount: 1 },
      nodes: [{ id: 'external:react', label: 'react', external: true, lines: 0 }],
      edges: [], cycles: [], violations: [],
    }],
  ];
  for (const [label, report] of cases) {
    let text = null;
    try {
      text = renderText(report);
    } catch (err) {
      text = null;
      check(`renderText：${label} 不抛错`, false, err.message);
      continue;
    }
    check(`renderText：${label} 不抛错`, typeof text === 'string' && text.length > 0,
      JSON.stringify(text?.slice(0, 60)));
  }

  // buildReport 的 schemaVersion 必须稳定
  const r = buildReport({
    root: '/x',
    graph: { nodes: [], edges: [], cycles: [], cycleEdges: new Set(), stats: { nodeCount: 0 } },
    layout: { nodes: [], edges: [], width: 0, height: 0, contentWidth: 0 },
  });
  check('buildReport：空图产出合法报告', r.schemaVersion === 1 && Array.isArray(r.nodes));
  check('buildReport：extras 缺失时不报错', typeof r.stats === 'object');
}

// ---------------------------------------------------------------------------
// 8) 空仓库与极端小仓库的完整产物矩阵
// ---------------------------------------------------------------------------
{
  const empty = join(work, 'empty');
  await mk(empty);
  await writeFile(join(empty, 'a.txt'), 'not source\n', 'utf8');

  for (const fmt of ['svg', 'html', 'json']) {
    const r = await cli([empty, '--format', fmt, '--quiet']);
    let ok = !crashed(r) && r.code === 0;
    if (ok && fmt === 'json') {
      ok = JSON.parse(r.stdout).stats.nodeCount === 0;
    } else if (ok) {
      const expected = fmt === 'html' ? '<!doctype html>' : '<svg';
      ok = r.stdout.trimStart().toLowerCase().startsWith(expected);
    }
    check(`空仓库：--format ${fmt} 产出可用结果`, ok, `exit=${r.code}`);
  }

  // 单文件仓库
  const single = join(work, 'single');
  await mk(single);
  await writeFile(join(single, 'only.ts'), 'export const only = 1;\n', 'utf8');
  for (const fmt of ['svg', 'html', 'json']) {
    const r = await cli([single, '--format', fmt, '--quiet']);
    check(`单文件仓库：--format ${fmt}`, r.code === 0 && !crashed(r), `exit=${r.code}`);
  }

  // 只有外部依赖的仓库
  const extOnly = join(work, 'ext-only');
  await mk(extOnly);
  await writeFile(join(extOnly, 'a.ts'), "import react from 'react';\nexport const v = react;\n", 'utf8');
  const r = await cli([extOnly, '--format', 'svg', '--quiet']);
  check('只有外部依赖：SVG 能画出来', r.code === 0 && r.stdout.includes('<svg'), `exit=${r.code}`);
  const json = await cli([extOnly, '--json', '--quiet']);
  const extReport = JSON.parse(json.stdout);
  // 仓库里那一个文件本身是内部节点；react 只作为折叠的外部节点出现
  check('只有外部依赖：内部节点只有那个文件',
    extReport.stats.nodeCount === 1 && extReport.stats.externalCount === 1,
    `nodeCount=${extReport.stats.nodeCount}, externalCount=${extReport.stats.externalCount}`);
  check('只有外部依赖：没有任何内部边', extReport.stats.edgeCount === 0);
  check('只有外部依赖：外部包名出现在报告里',
    extReport.nodes.some((n) => n.external && n.label === 'react'));
}

// ---------------------------------------------------------------------------
// 9) 输出体积与节点数的关系（不能出现二次爆炸）
// ---------------------------------------------------------------------------
{
  const big = join(work, 'big');
  await mk(join(big, 'src'));
  const counts = [50, 100, 200];
  const sizes = [];
  for (const n of counts) {
    const dir = join(big, `n${n}`);
    await mk(join(dir, 'src'));
    for (let i = 0; i < n; i += 1) {
      const dep = i > 0 ? `import { a } from './m${i - 1}';\n` : '';
      await writeFile(join(dir, 'src', `m${i}.ts`), `${dep}export const a = ${i};\n`, 'utf8');
    }
    const svg = await cli([dir, '--max-nodes', '10000', '--quiet']);
    sizes.push(svg.stdout.length);
  }
  // 体积应大致线性：200 节点的体积不应超过 50 节点的 4 倍太多
  const ratio = sizes[2] / sizes[0];
  check('输出体积随节点数近似线性（无二次爆炸）', ratio < 8,
    `${counts[0]}→${sizes[0]}B, ${counts[2]}→${sizes[2]}B, 比值 ${ratio.toFixed(2)}`);
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
  process.exit(1);
}
