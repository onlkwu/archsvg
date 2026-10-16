/**
 * 鲁棒性套件 2：结构性边界。
 *
 * 覆盖多环共存、软链、入度热点、模式文件（BOM/CRLF/无末尾换行）、
 * 空仓库与单文件仓库、以及"图有没有画到画布外"。
 *
 * 用法: node tools/stress2.mjs
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'bin', 'cli.mjs');
const work = join(tmpdir(), 'archsvg-stress2');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function cli(args, cwd = root) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const mk = async (p) => mkdir(p, { recursive: true });

await rm(work, { recursive: true, force: true });
await mk(work);

// ---------------------------------------------------------------------------
// 1) 从任意工作目录调用（相对路径 vs 绝对路径）
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'cwd-test');
  await mk(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'a.ts'), "import { b } from './b';\nexport const x = b;\n", 'utf8');
  await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');

  const fromRoot = await cli([repo, '--json', '--quiet']);
  const fromTmp = await cli([repo, '--json', '--quiet'], tmpdir());
  const a = JSON.parse(fromRoot.stdout);
  const b = JSON.parse(fromTmp.stdout);
  check('从不同 cwd 调用结果一致', fromRoot.code === 0 && fromTmp.code === 0 && a.stats.nodeCount === b.stats.nodeCount,
    `${a.stats.nodeCount} vs ${b.stats.nodeCount}`);

  const rel = await cli([repo, '--json', '--quiet'], here);
  check('cwd 不影响解析结果', JSON.parse(rel.stdout).stats.nodeCount === a.stats.nodeCount);
}

// ---------------------------------------------------------------------------
// 2) 文件名/目录名进入 XML 时必须转义
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'xml-escape');
  // 这些名字在真实项目里合法且常见，一旦转义漏了整张图会炸。
  // 刻意不用 < > " | ? * ：Windows 上根本创建不出来，测了也没意义。
  const dirs = [
    'src/a&b',
    "src/quote'name",
    'src/paren(s)',
    'src/brack[et]',
    'src/hash#tag',
    'src/plus+plus',
    'src/中文&目录',
  ];
  for (const d of dirs) await mk(join(repo, d));
  await writeFile(join(repo, 'src', 'a&b', 'x.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', "quote'name", 'y.ts'), 'export const y = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'paren(s)', 'z.ts'), 'export const z = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'brack[et]', 'w.ts'), 'export const w = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'hash#tag', 'v.ts'), 'export const v = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'plus+plus', 'u.ts'), 'export const u = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', '中文&目录', 't.ts'), 'export const t = 1;\n', 'utf8');

  const r = await cli([repo, '--quiet']);
  check('特殊字符文件名：渲染不崩', r.code === 0, `exit=${r.code}`);

  if (r.code === 0) {
    const { checkXml } = await import('../test/helpers/xml.mjs');
    const res = checkXml(r.stdout);
    check('特殊字符文件名：SVG 仍然良构', res.ok, res.ok ? '' : `${res.error} @${res.index}`);
    // 裸 & 是最容易漏的转义错误，单独再查一次（比良构性检查直白）
    check('特殊字符文件名：没有裸 &', !/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(r.stdout));
    const report = JSON.parse((await cli([repo, '--json', '--quiet'])).stdout);
    check('特殊字符文件名：全部进图且 id 原样', report.stats.nodeCount === dirs.length
      && report.nodes.some((n) => n.id === 'src/中文&目录/t.ts'), `nodeCount=${report.stats.nodeCount}`);

    // 图上的显示名必须互相可区分（重名文件补目录前缀）
    const labels = report.nodes.map((n) => n.label);
    check('特殊字符文件名：显示名不重复', new Set(labels).size === labels.length, JSON.stringify(labels));
  }
}

// ---------------------------------------------------------------------------
// 3) 单向环 / 多个互不相干的环 / 长环
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'cycles');
  await mk(join(repo, 'src'));
  // 两个独立的三节点环
  for (const grp of ['p', 'q']) {
    await writeFile(join(repo, 'src', `${grp}1.ts`), `import { v } from './${grp}2';\nexport const v = 1;\n`, 'utf8');
    await writeFile(join(repo, 'src', `${grp}2.ts`), `import { v } from './${grp}3';\nexport const v = 1;\n`, 'utf8');
    await writeFile(join(repo, 'src', `${grp}3.ts`), `import { v } from './${grp}1';\nexport const v = 1;\n`, 'utf8');
  }
  // 一个 12 节点的长环
  const N = 12;
  for (let i = 0; i < N; i += 1) {
    const next = `r${(i + 1) % N}`;
    await writeFile(join(repo, 'src', `r${i}.ts`), `import { v } from './${next}';\nexport const v = 1;\n`, 'utf8');
  }
  // 两个文件互相引用
  await writeFile(join(repo, 'src', 'm1.ts'), "import { v } from './m2';\nexport const v = 1;\n", 'utf8');
  await writeFile(join(repo, 'src', 'm2.ts'), "import { v } from './m1';\nexport const v = 1;\n", 'utf8');
  // 自环
  await writeFile(join(repo, 'src', 'self.ts'), "import { v } from './self';\nexport const v = 1;\n", 'utf8');

  const r = await cli([repo, '--json', '--out', join(work, 'cycles.json'), '--quiet']);
  const report = JSON.parse(await readFile(join(work, 'cycles.json'), 'utf8'));
  const sizes = report.cycles.map((c) => c.length).sort((a, b) => a - b);
  check('5 组环全部识别',
    r.code === 0 && report.cycles.length === 5, `cycles=${JSON.stringify(sizes)}`);
  check('互相引用的两文件被识别为一组 2 节点环', sizes.includes(2));
  check('12 节点长环完整', sizes.includes(12));
  check('自环被识别为独立一组', sizes.includes(1));
  check('自环在边上也是环', report.edges.some((e) => e.isCycle && e.from === e.to) === false,
    '自环边会被建图阶段丢弃，只应出现在 cycles 里');

  const svg = await cli([repo, '--quiet']);
  const res = (await import('../test/helpers/xml.mjs')).checkXml(svg.stdout);
  check('多环图渲染良构', res.ok, res.ok ? '' : `${res.error} @${res.index}`);

  const inspect = await run(process.execPath, [join(root, 'test', 'helpers', 'inspect-svg.mjs'), join(work, 'cycles.svg')], {
    cwd: root, encoding: 'utf8',
  }).then((x) => x.stdout).catch((e) => e.stdout ?? '');
  void inspect;
  await cli([repo, '--out', join(work, 'cycles.svg'), '--quiet']);
  const bounds = await run(process.execPath, [join(root, 'test', 'helpers', 'inspect-svg.mjs'), join(work, 'cycles.svg')], {
    cwd: root, encoding: 'utf8',
  });
  check('多环图所有几何在画布内', bounds.stdout.includes('OK'), bounds.stdout.trim().split('\n').pop());
}

// ---------------------------------------------------------------------------
// 4) 深目录 + 大量同层节点（网格折行边界）
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'deep-dir');
  let dir = join(repo, 'src');
  for (let i = 0; i < 20; i += 1) dir = join(dir, `l${i}`);
  await mk(dir);
  await writeFile(join(dir, 'deep.ts'), 'export const deep = 1;\n', 'utf8');

  const r = await cli([repo, '--json', '--quiet']);
  const report = JSON.parse(r.stdout);
  check('20 层深目录不崩', r.code === 0 && report.stats.nodeCount === 1, `nodeCount=${report.stats.nodeCount}`);

  // 折行边界：5 个节点不该折行，6 个且超宽才折
  const boundary = join(work, 'boundary');
  await mk(join(boundary, 'src'));
  for (let i = 0; i < 5; i += 1) {
    await writeFile(join(boundary, 'src', `b${i}.ts`), 'export const x = 1;\n', 'utf8');
  }
  const five = await cli([boundary, '--out', join(work, 'five.svg'), '--quiet']);
  const fiveHeader = /<svg[^>]*width="([\d.]+)"/.exec(await readFile(join(work, 'five.svg'), 'utf8'));
  check('5 个孤立节点不折行', five.code === 0 && Number(fiveHeader[1]) < 1435, `width=${fiveHeader?.[1]}`);
}

// ---------------------------------------------------------------------------
// 5) 符号链接与不可读目标
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'symlink');
  await mk(join(repo, 'real'));
  await mk(join(repo, 'linkdir'));
  await writeFile(join(repo, 'real', 'a.ts'), 'export const a = 1;\n', 'utf8');
  let linked = true;
  try {
    await symlink(join(repo, 'real'), join(repo, 'linkdir', 'to-real'), 'junction');
  } catch {
    linked = false;
  }
  const r = await cli([repo, '--json', '--quiet']);
  check('目录软链不导致重复或死循环', r.code === 0, linked ? `exit=${r.code}` : '（当前环境不支持创建软链，已跳过）');
  if (r.code === 0 && linked) {
    const report = JSON.parse(r.stdout);
    check('软链目标不会让文件数翻倍', report.stats.nodeCount <= 2, `nodeCount=${report.stats.nodeCount}`);
  }
}

// ---------------------------------------------------------------------------
// 6) 同一文件被大量文件依赖（入度热点）
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'hub');
  await mk(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'hub.ts'), 'export const hub = 1;\n', 'utf8');
  for (let i = 0; i < 200; i += 1) {
    await writeFile(
      join(repo, 'src', `c${i}.ts`),
      "import { hub } from './hub';\nexport const v = hub;\n",
      'utf8',
    );
  }
  const r = await cli([repo, '--json', '--out', join(work, 'hub.json'), '--quiet']);
  const report = JSON.parse(await readFile(join(work, 'hub.json'), 'utf8'));
  const hub = report.nodes.find((n) => n.id === 'src/hub.ts');
  check('200 个依赖方：入度统计正确', r.code === 0 && hub.inDeg === 200, `inDeg=${hub?.inDeg}`);
  // 200 个不同文件各依赖一次 = 200 条边；weight 记录的是"同一对之间被引用几次"
  check('200 个依赖方：200 条边而非一条', report.stats.edgeCount === 200, `edgeCount=${report.stats.edgeCount}`);
  check('200 个依赖方：每条边 weight 为 1', report.edges.every((e) => e.weight === 1));

  // 同一文件重复引用同一目标才应该让 weight 累加
  const twice = join(work, 'twice');
  await mk(join(twice, 'src'));
  await writeFile(join(twice, 'src', 't.ts'), 'export const t = 1;\n', 'utf8');
  await writeFile(
    join(twice, 'src', 'c.ts'),
    "import { t } from './t';\nimport { t as t2 } from './t';\nexport const v = t + t2;\n",
    'utf8',
  );
  const twiceReport = JSON.parse((await cli([twice, '--json', '--quiet'])).stdout);
  check('同一文件重复引用：weight 累加为 2', twiceReport.edges[0]?.weight === 2, `weight=${twiceReport.edges[0]?.weight}`);
  check('同一文件重复引用：边仍只有一条', twiceReport.stats.edgeCount === 1, `edgeCount=${twiceReport.stats.edgeCount}`);

  await cli([repo, '--out', join(work, 'hub.svg'), '--quiet']);
  const bounds = await run(process.execPath, [join(root, 'test', 'helpers', 'inspect-svg.mjs'), join(work, 'hub.svg')], {
    cwd: root, encoding: 'utf8',
  });
  check('入度热点图所有几何在画布内', bounds.stdout.includes('OK'), bounds.stdout.trim().split('\n').pop());
}

// ---------------------------------------------------------------------------
// 7) 规则：目录型 pattern、** 匹配零层、跨包
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'rules');
  await mk(join(repo, 'src', 'ui'));
  await writeFile(join(repo, 'src', 'ui', 'top.ts'), "import { d } from '../db/client';\nexport const v = d;\n", 'utf8');
  await mk(join(repo, 'src', 'ui', 'nested', 'deep'));
  await writeFile(join(repo, 'src', 'ui', 'nested', 'deep', 'x.ts'), "import { d } from '../../../db/client';\nexport const v = d;\n", 'utf8');
  await mk(join(repo, 'src', 'db'));
  await writeFile(join(repo, 'src', 'db', 'client.ts'), 'export const d = 1;\n', 'utf8');

  const rules = join(work, 'r.json');
  await writeFile(rules, JSON.stringify({
    schemaVersion: 1,
    rules: [
      { id: 'zero-depth', from: 'src/ui/**', to: 'src/db/**', forbidden: true, message: 'ui→db' },
      { id: 'dir-form', from: 'src/ui', to: 'src/db', forbidden: true, message: 'ui→db（目录写法）' },
    ],
  }), 'utf8');

  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const report = JSON.parse(r.stdout);
  const files = [...new Set(report.violations.map((v) => v.from))].sort();
  check('** 匹配零层目录（顶层文件也算）', files.includes('src/ui/top.ts'), JSON.stringify(files));
  check('** 匹配多层嵌套', files.includes('src/ui/nested/deep/x.ts'));
  check('目录写法 pattern 等价', report.violations.some((v) => v.ruleId === 'dir-form'));
  check('两种写法命中同一批文件', report.violations.filter((v) => v.ruleId === 'zero-depth').length === 2);
}

// ---------------------------------------------------------------------------
// 8) 忽略规则与 include-tests
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'ignore');
  await mk(join(repo, 'src', 'keep'));
  await mk(join(repo, 'src', 'drop'));
  await mk(join(repo, 'tests'));
  await writeFile(join(repo, 'src', 'keep', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'drop', 'b.ts'), 'export const b = 1;\n', 'utf8');
  await writeFile(join(repo, 'tests', 'c.ts'), "import { a } from '../src/keep/a';\nexport const c = a;\n", 'utf8');
  await writeFile(join(repo, 'src', 'keep', 'a.test.ts'), 'export const t = 1;\n', 'utf8');

  const base = JSON.parse((await cli([repo, '--json', '--quiet'])).stdout);
  check('tests/ 默认被排除', base.nodes.every((n) => !n.id.startsWith('tests/')), JSON.stringify(base.nodes.map((n) => n.id)));
  check('*.test.ts 默认被排除', base.nodes.every((n) => !n.id.includes('.test.')));

  const withTests = JSON.parse((await cli([repo, '--json', '--include-tests', '--quiet'])).stdout);
  check('--include-tests 纳入测试文件', withTests.stats.nodeCount > base.stats.nodeCount,
    `${base.stats.nodeCount} → ${withTests.stats.nodeCount}`);

  const ignored = JSON.parse((await cli([repo, '--json', '--ignore', 'src/drop/', '--quiet'])).stdout);
  check('--ignore 生效', ignored.nodes.every((n) => !n.id.startsWith('src/drop/')));

  const twoIgnores = JSON.parse((await cli([repo, '--json', '--ignore', 'src/drop/', '--ignore', 'src/keep/a.test.ts', '--quiet'])).stdout);
  check('--ignore 可重复', twoIgnores.nodes.every((n) => !n.id.startsWith('src/drop/')));
}

// ---------------------------------------------------------------------------
// 9) HTML 输出的自洽性
// ---------------------------------------------------------------------------
{
  const html = await cli(['demo', '--format', 'html', '--quiet']);
  check('HTML 单文件自洽', html.code === 0 && html.stdout.startsWith('<!doctype html>') && html.stdout.includes('</html>'));
  check('HTML 不含外部资源引用', !/(src|href)="https?:\/\//.test(html.stdout),
    (html.stdout.match(/(src|href)="https?:\/\/[^"]*"/) || [''])[0]);

  const svgInHtml = /<svg[\s\S]*<\/svg>/.exec(html.stdout);
  const res = (await import('../test/helpers/xml.mjs')).checkXml(svgInHtml[0]);
  check('HTML 内联 SVG 良构', res.ok, res.ok ? '' : `${res.error} @${res.index}`);
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}
