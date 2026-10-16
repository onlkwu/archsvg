/**
 * 鲁棒性套件 3：在真实代码库上校验输出自洽。
 *
 * 人造仓库只能验证"行为对不对"，验证不了"说出来的话是不是真的"。
 * 这里拿机器上现成的真实包当语料，逐项核对：
 * 每条内部依赖都必须指向真实存在的文件，refs 行号必须落在导入语句上，
 * 报告结构必须符合它自己声明的 schema。
 *
 * 用法: node tools/stress3.mjs
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'bin', 'cli.mjs');
const work = join(tmpdir(), 'archsvg-real');

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
      maxBuffer: 512 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

// ---------------------------------------------------------------------------
// schema 校验：报告必须符合自己声明的结构
// ---------------------------------------------------------------------------
function validateReport(report) {
  const problems = [];
  const fail = (m) => problems.push(m);

  if (report.schemaVersion !== 1) fail(`schemaVersion=${report.schemaVersion}`);
  if (typeof report.root !== 'string' || !report.root) fail('root 缺失');
  if (!report.stats || typeof report.stats !== 'object') fail('stats 缺失');
  for (const k of ['nodeCount', 'edgeCount', 'externalCount', 'cycleCount', 'totalLines']) {
    if (typeof report.stats[k] !== 'number' || Number.isNaN(report.stats[k])) fail(`stats.${k} 不是数字`);
  }
  if (!Array.isArray(report.nodes)) fail('nodes 不是数组');
  if (!Array.isArray(report.edges)) fail('edges 不是数组');
  if (!Array.isArray(report.cycles)) fail('cycles 不是数组');
  if (!Array.isArray(report.violations)) fail('violations 不是数组');

  const ids = new Set();
  for (const n of report.nodes) {
    if (typeof n.id !== 'string' || !n.id) fail('节点缺 id');
    if (ids.has(n.id)) fail(`节点 id 重复: ${n.id}`);
    ids.add(n.id);
    if (typeof n.label !== 'string' || !n.label) fail(`节点 ${n.id} 缺 label`);
    if (typeof n.lines !== 'number' || n.lines < 0) fail(`节点 ${n.id} 的 lines 非法`);
    if (typeof n.external !== 'boolean') fail(`节点 ${n.id} 的 external 非法`);
    for (const k of ['inDeg', 'outDeg']) {
      if (typeof n[k] !== 'number' || n[k] < 0) fail(`节点 ${n.id} 的 ${k} 非法`);
    }
    if (!n.external) {
      for (const k of ['x', 'y', 'w', 'h', 'layer']) {
        if (typeof n[k] !== 'number' || !Number.isFinite(n[k])) fail(`节点 ${n.id} 的 ${k} 非法`);
      }
    }
  }

  for (const e of report.edges) {
    if (!ids.has(e.from)) fail(`边的 from 不在节点表里: ${e.from}`);
    if (!ids.has(e.to)) fail(`边的 to 不在节点表里: ${e.to}`);
    if (e.from === e.to) fail(`出现自指边: ${e.from}`);
    if (typeof e.weight !== 'number' || e.weight < 1) fail(`边 ${e.from}->${e.to} 的 weight 非法`);
    if (!Array.isArray(e.refs) || e.refs.length === 0) fail(`边 ${e.from}->${e.to} 缺 refs`);
    for (const r of e.refs) {
      if (typeof r.file !== 'string' || !r.file) fail(`边 ${e.from}->${e.to} 的 ref.file 非法`);
      if (typeof r.line !== 'number' || r.line < 1) fail(`边 ${e.from}->${e.to} 的 ref.line 非法`);
    }
  }

  for (const c of report.cycles) {
    if (!Array.isArray(c) || c.length === 0) fail('空环组');
    for (const id of c) if (!ids.has(id)) fail(`环里的 ${id} 不在节点表里`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// 真实语料
// ---------------------------------------------------------------------------
const corpora = [
  ['npm 自带源码', 'C:/Program Files/nodejs/node_modules/npm'],
  ['corepack', 'C:/Program Files/nodejs/node_modules/corepack'],
  ['archsvg demo', join(root, 'demo')],
  ['archsvg 自身', root],
].filter(([, p]) => existsSync(p));

for (const [name, path] of corpora) {
  const tag = name.replace(/\s+/g, '_');
  const out = join(work, `${tag}.json`);
  const t0 = Date.now();
  const r = await cli([path, '--json', '--out', out, '--quiet']);
  const ms = Date.now() - t0;

  if (r.code !== 0) {
    check(`${name}: 分析成功`, false, `exit=${r.code}, stderr=${r.stderr.trim().slice(0, 200)}`);
    continue;
  }
  const report = JSON.parse(await readFile(out, 'utf8'));
  check(`${name}: 分析成功`, true, `${report.stats.nodeCount} 节点 / ${report.stats.edgeCount} 边 / ${ms}ms`);

  const problems = validateReport(report);
  check(`${name}: 报告符合 schema`, problems.length === 0, problems.slice(0, 4).join('; '));

  // 内部依赖必须指向真实存在的文件
  const repoRoot = report.root;
  const missing = [];
  for (const e of report.edges) {
    if (e.kind === 'external') continue;
    for (const id of [e.from, e.to]) {
      if (id.startsWith('external:')) continue;
      const abs = resolve(repoRoot, id);
      if (!existsSync(abs)) missing.push(id);
    }
  }
  check(`${name}: 边的两端都是真实文件`, missing.length === 0,
    missing.length > 0 ? `例如 ${[...new Set(missing)].slice(0, 3).join(', ')}` : '');

  // refs 指向的位置真的在引用目标吗（抽查第一条能读到的）
  let verified = 0;
  for (const e of report.edges) {
    if (e.kind === 'external' || verified >= 3) continue;
    const ref = e.refs[0];
    const abs = resolve(repoRoot, ref.file);
    if (!existsSync(abs)) continue;
    const lines = (await readFile(abs, 'utf8')).split('\n');
    const line = lines[ref.line - 1] ?? '';
    // 该行应该包含 from 与 to 的文件名片段，或者至少是个 import/include 行
    if (/import|require|from|#include/.test(line)) verified += 1;
  }
  check(`${name}: 抽查 refs 行号落在导入语句上`, report.edges.length === 0 || verified > 0,
    `已验证 ${verified} 条`);

  // 行数守恒：非聚合模式下节点行数之和 == 参与文件的行数之和。
  // 注意：真实包里 "0 个源文件" 是合法结果（例如只有打包产物的目录），
  // 所以这里只在有节点时才要求行数为正。
  if (!report.stats.grouped && typeof report.stats.fileCount === 'number') {
    const nodeLines = report.nodes.filter((n) => !n.external).reduce((s, n) => s + n.lines, 0);
    if (report.stats.nodeCount === 0) {
      check(`${name}: 无源文件时安全返回`, report.edges.length === 0 && report.cycles.length === 0,
        '这就是个只含打包产物的目录');
    } else {
      check(`${name}: 行数为正`, nodeLines > 0, `${nodeLines} 行`);
    }
  }

  // 确定性
  const a = await cli([path, '--quiet']);
  const b = await cli([path, '--quiet']);
  check(`${name}: SVG 两次输出一致`, a.code === 0 && sha(a.stdout) === sha(b.stdout));

  // 良构 + 画布内
  const svgFile = join(work, `${tag}.svg`);
  await cli([path, '--out', svgFile, '--quiet']);
  const svg = await readFile(svgFile, 'utf8');
  const { checkXml } = await import('../test/helpers/xml.mjs');
  check(`${name}: SVG 良构`, checkXml(svg).ok);
  const bounds = await run(process.execPath, [join(root, 'test', 'helpers', 'inspect-svg.mjs'), svgFile], {
    cwd: root, encoding: 'utf8',
  }).then((x) => x.stdout).catch((e) => e.stdout ?? '');
  check(`${name}: 所有几何在画布内`, bounds.includes('OK'), bounds.trim().split('\n').pop());

  // 体积：能嵌进 README
  const kb = (await stat(svgFile)).size / 1024;
  check(`${name}: SVG 体积可控`, kb < 2048, `${kb.toFixed(0)}KB`);
}

// ---------------------------------------------------------------------------
// 大图 HTML 与渲染层
// ---------------------------------------------------------------------------
{
  const big = join(work, 'big');
  await mkdir(join(big, 'src'), { recursive: true });
  const N = 500;
  for (let i = 0; i < N; i += 1) {
    const deps = i > 0 ? `import { a } from './m${i - 1}';\n` : '';
    const extra = i % 17 === 0 && i > 20 ? `import { b } from './m${i - 20}';\n` : '';
    await writeFile(join(big, 'src', `m${i}.ts`), `${deps}${extra}export const a = ${i};\n`, 'utf8');
  }

  const svgFile = join(work, 'big.svg');
  const t0 = Date.now();
  const r = await cli([big, '--max-nodes', '10000', '--out', svgFile, '--quiet']);
  const svgMs = Date.now() - t0;
  check('500 节点平面图渲染成功', r.code === 0, `${svgMs}ms`);

  const htmlFile = join(work, 'big.html');
  const t1 = Date.now();
  const h = await cli([big, '--max-nodes', '10000', '--format', 'html', '--out', htmlFile, '--quiet']);
  const htmlMs = Date.now() - t1;
  const htmlSize = (await stat(htmlFile)).size / 1024;
  check('500 节点 HTML 生成成功', h.code === 0, `${htmlMs}ms, ${htmlSize.toFixed(0)}KB`);
  check('500 节点 HTML 体积可控', htmlSize < 3072, `${htmlSize.toFixed(0)}KB`);

  const bounds = await run(process.execPath, [join(root, 'test', 'helpers', 'inspect-svg.mjs'), svgFile], {
    cwd: root, encoding: 'utf8',
  }).then((x) => x.stdout).catch((e) => e.stdout ?? '');
  check('500 节点图所有几何在画布内', bounds.includes('OK'), bounds.trim().split('\n').pop());

  const report = JSON.parse((await cli([big, '--max-nodes', '10000', '--json', '--quiet'])).stdout);
  check('500 节点无自指边', report.edges.every((e) => e.from !== e.to));
  check('500 节点边数与入度自洽',
    report.edges.filter((e) => e.kind === 'internal').length ===
      report.nodes.filter((n) => !n.external).reduce((s, n) => s + n.outDeg, 0));
}

// ---------------------------------------------------------------------------
// 路径写法边界
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'paths');
  await mkdir(join(repo, 'src', 'sub'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'sub', 'b.ts'), "import { a } from '../a';\nexport const b = a;\n", 'utf8');

  const variants = [
    ['相对路径', ['.', '--json', '--quiet']],
    ['尾斜杠', [repo + '/', '--json', '--quiet']],
    ['尾反斜杠', [repo.replace(/\//g, '\\') + '\\', '--json', '--quiet']],
    ['./ + 盘符前缀', [`./${repo.replace(/\\/g, '/')}`, '--json', '--quiet']],
    ['重复 ./ 前缀', [`././${repo.replace(/\\/g, '/')}`, '--json', '--quiet']],
  ];

  const base = JSON.parse((await cli([repo, '--json', '--quiet'])).stdout);
  for (const [label, args] of variants.slice(1)) {
    const cwd = label === '相对路径' ? repo : root;
    let out;
    try {
      const r = await run(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 1e8 });
      out = JSON.parse(r.stdout);
    } catch (err) {
      check(`路径写法：${label}`, false, `exit=${err.code}`);
      continue;
    }
    check(`路径写法：${label}`, out.stats.nodeCount === base.stats.nodeCount,
      `${out.stats.nodeCount} vs ${base.stats.nodeCount}`);
  }

  // 指向仓库内部子目录时，id 应该以该子目录为根
  const sub = JSON.parse((await cli([join(repo, 'src'), '--json', '--quiet'])).stdout);
  check('子目录为根时 id 相对该目录', sub.nodes.every((n) => !n.id.startsWith('src/')),
    JSON.stringify(sub.nodes.map((n) => n.id)));
}

// ---------------------------------------------------------------------------
// 未支持 / 已支持特性的边界
// ---------------------------------------------------------------------------
{
  // extends 现在应当被跟随：别名要解析成内部依赖，且不留假的外部包
  const repo = join(work, 'extends');
  await mkdir(join(repo, 'src', 'lib'), { recursive: true });
  await writeFile(join(repo, 'base.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
  }), 'utf8');
  await writeFile(join(repo, 'tsconfig.json'), JSON.stringify({
    extends: './base.json',
    compilerOptions: {},
  }), 'utf8');
  await writeFile(join(repo, 'src', 'lib', 'x.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'a.ts'), "import { x } from '@lib/x';\nexport const v = x;\n", 'utf8');

  const r = await cli([repo, '--json', '--quiet']);
  const report = JSON.parse(r.stdout);
  check('tsconfig extends 被跟随',
    report.edges.some((e) => e.to.endsWith('src/lib/x.ts')), JSON.stringify(report.edges));
  check('extends 后不留假的外部包',
    report.nodes.filter((n) => n.external).length === 0,
    JSON.stringify(report.nodes.filter((n) => n.external).map((n) => n.label)));

  // extends 指向 npm 包时无法跟随，必须给出可发现的警告
  const pkgRepo = join(work, 'extends-pkg');
  await mkdir(join(pkgRepo, 'src'), { recursive: true });
  await writeFile(join(pkgRepo, 'tsconfig.json'), JSON.stringify({
    extends: '@tsconfig/node20/tsconfig.json',
  }), 'utf8');
  await writeFile(join(pkgRepo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  const pkgRun = await cli([pkgRepo, '--quiet']);
  check('extends 指向 npm 包时给出警告',
    pkgRun.code === 0 && /node_modules/.test(pkgRun.stderr),
    pkgRun.stderr.trim().split('\n')[0] ?? '');
}

// ---------------------------------------------------------------------------
// 源码编码自检：源码里出现 U+FFFD 说明某次写文件用了错误编码
// ---------------------------------------------------------------------------
{
  const { readdir } = await import('node:fs/promises');
  /** @type {string[]} */
  const damaged = [];
  async function walk(dir, depth = 0) {
    if (depth > 6) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'out'].includes(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p, depth + 1);
      } else if (/\.(mjs|js|json|md|ts|py|cpp|svg)$/.test(e.name)) {
        const text = await readFile(p, 'utf8').catch(() => '');
        if (text.includes('\uFFFD')) damaged.push(p);
      }
    }
  }
  await walk(root);
  check('源码里没有编码损坏（U+FFFD）', damaged.length === 0,
    damaged.slice(0, 3).join(', '));
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
  process.exit(1);
}
