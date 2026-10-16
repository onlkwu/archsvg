/**
 * 鲁棒性套件 4：现代 Node 模块写法的边界。
 *
 * 覆盖 package.json 的 imports 字段（# 别名）、同目录多份 tsconfig 的选择、
 * 软链指向仓库外部、exports 字段、目录名与文件名同名、BOM/CRLF 与无末尾换行。
 *
 * 用法: node tools/stress4.mjs
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'bin', 'cli.mjs');
const work = join(tmpdir(), 'archsvg-stress4');

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
      maxBuffer: 256 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const analyze = async (repo, extra = []) => {
  const r = await cli([repo, '--json', '--quiet', ...extra]);
  return { code: r.code, report: r.code === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};

const mk = (p) => mkdir(p, { recursive: true });
const edgesOf = (report) => report.edges.map((e) => `${e.from}->${e.to}`).sort();
const externalsOf = (report) => report.nodes.filter((n) => n.external).map((n) => n.label).sort();

await rm(work, { recursive: true, force: true });
await mk(work);

// ---------------------------------------------------------------------------
// 1) package.json 的 imports 字段（# 开头的作用域内别名）
//    现代 Node 项目用它替代 tsconfig paths，写错会把依赖全变成 unresolved
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'pkg-imports');
  await mk(join(repo, 'src', 'utils'));
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'pkg-imports',
    type: 'module',
    imports: {
      '#utils/*': './src/utils/*',
      '#config': './src/config.js',
    },
  }, null, 2), 'utf8');
  await writeFile(join(repo, 'src', 'utils', 'date.js'), 'export const d = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'config.js'), 'export const c = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'a.js'),
    "import { d } from '#utils/date.js';\nimport { c } from '#config';\nexport const v = d + c;\n", 'utf8');

  const { code, report } = await analyze(repo);
  check('package.json imports：分析成功', code === 0, `exit=${code}`);
  if (report) {
    const edges = edgesOf(report);
    check('# 别名解析成内部依赖',
      edges.includes('src/a.js->src/utils/date.js') && edges.includes('src/a.js->src/config.js'),
      JSON.stringify(edges));
    check('# 别名不留假的外部包', externalsOf(report).length === 0, JSON.stringify(externalsOf(report)));
    check('# 别名不产生 unresolved', report.stats.unresolved === 0, `unresolved=${report.stats.unresolved}`);
  }
}

// ---------------------------------------------------------------------------
// 2) 同目录多个 tsconfig 时的选择
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'multi-tsconfig');
  await mk(join(repo, 'src'));
  // tsconfig.json 不定义别名；tsconfig.build.json 定义。
  // 默认应该用 tsconfig.json（Node/tsc 的默认行为也是它）。
  await writeFile(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf8');
  await writeFile(join(repo, 'tsconfig.build.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@x/*': ['src/x/*'] } },
  }), 'utf8');
  await mk(join(repo, 'src', 'x'));
  await writeFile(join(repo, 'src', 'x', 'y.ts'), 'export const y = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'a.ts'), "import { y } from '@x/y';\nexport const v = y;\n", 'utf8');

  const { report } = await analyze(repo);
  check('同目录多个 tsconfig：默认用 tsconfig.json（不误用 tsconfig.build.json）',
    report && !edgesOf(report).some((e) => e.endsWith('src/x/y.ts')),
    JSON.stringify(edgesOf(report)));

  // 只有 jsconfig.json 时应该也能读到
  const jsRepo = join(work, 'jsconfig');
  await mk(join(jsRepo, 'src', 'lib'));
  await writeFile(join(jsRepo, 'jsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['src/lib/*'] } },
  }), 'utf8');
  await writeFile(join(jsRepo, 'src', 'lib', 'z.js'), 'export const z = 1;\n', 'utf8');
  await writeFile(join(jsRepo, 'src', 'm.js'), "import { z } from '@lib/z';\nexport const v = z;\n", 'utf8');
  const js = await analyze(jsRepo);
  check('jsconfig.json 也能提供别名',
    js.report && edgesOf(js.report).includes('src/m.js->src/lib/z.js'),
    JSON.stringify(js.report ? edgesOf(js.report) : js.code));
}

// ---------------------------------------------------------------------------
// 3) 软链指向仓库外部
// ---------------------------------------------------------------------------
{
  const outside = join(work, 'outside');
  await mk(outside);
  await writeFile(join(outside, 'ext.ts'), 'export const ext = 1;\n', 'utf8');

  const repo = join(work, 'symlink-out');
  await mk(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  let linked = true;
  try {
    await symlink(outside, join(repo, 'src', 'linked'), 'junction');
  } catch {
    linked = false;
  }
  const { code, report } = await analyze(repo);
  check('软链指向仓库外部：不崩', code === 0, `exit=${code}`);
  if (report) {
    // node_modules 之外的路径都不该被算成仓库内文件
    const outsideLeaked = report.nodes.filter((n) => !n.external).map((n) => n.id)
      .filter((id) => id.split('/').includes('..'));
    check('外层路径不泄漏成 .. 形式', outsideLeaked.length === 0, JSON.stringify(outsideLeaked));
    check('外部软链不产生重复节点', report.stats.nodeCount <= 2, `nodeCount=${report.stats.nodeCount}`);
  }
  void existsSync;
  void linked;
}

// ---------------------------------------------------------------------------
// 4) package.json exports / 子路径导入的边界
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'subpath');
  await mk(join(repo, 'src', 'feature'));
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'subpath',
    exports: { '.': './src/index.js', './feature': './src/feature/index.js' },
  }), 'utf8');
  await writeFile(join(repo, 'src', 'index.js'), "import './feature/index.js';\nexport const i = 1;\n", 'utf8');
  await writeFile(join(repo, 'src', 'feature', 'index.js'), 'export const f = 1;\n', 'utf8');

  const { code, report } = await analyze(repo);
  check('exports 字段不干扰正常解析', code === 0, `exit=${code}`);
  if (report) {
    check('exports 场景下依赖仍然解析出来',
      edgesOf(report).includes('src/index.js->src/feature/index.js'), JSON.stringify(edgesOf(report)));
  }
}

// ---------------------------------------------------------------------------
// 5) 目录名与文件名同名的歧义
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'ambiguity');
  await mk(join(repo, 'src', 'thing'));
  await writeFile(join(repo, 'src', 'thing.ts'), 'export const asFile = 1;\n', 'utf8');
  await writeFile(join(repo, 'src', 'thing', 'index.ts'), 'export const asDir = 2;\n', 'utf8');
  await writeFile(join(repo, 'src', 'a.ts'), "import { v } from './thing';\nexport const x = v;\n", 'utf8');

  const { report } = await analyze(repo);
  // Node/bundler 都是文件优先，行为必须可预测且稳定
  check('同名文件与目录：文件优先（与 Node 一致）',
    report && edgesOf(report).includes('src/a.ts->src/thing.ts'), JSON.stringify(edgesOf(report)));
}

// ---------------------------------------------------------------------------
// 6) 极端但合法的源文件内容
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'weird-content');
  await mk(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'bom.ts'), '\ufeffimport { b } from "./b";\nexport const a = b;\n', 'utf8');
  await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
  // CRLF 行尾
  await writeFile(join(repo, 'src', 'crlf.ts'), 'import { b } from "./b";\r\nexport const c = b;\r\n', 'utf8');
  // 没有末尾换行
  await writeFile(join(repo, 'src', 'noeol.ts'), 'import { b } from "./b";\nexport const d = b;', 'utf8');
  // 只有一行
  await writeFile(join(repo, 'src', 'one.ts'), 'export const e = 1;\n', 'utf8');

  const { code, report } = await analyze(repo);
  check('BOM / CRLF / 无末尾换行：解析成功', code === 0, `exit=${code}`);
  if (report) {
    const edges = edgesOf(report);
    check('BOM 文件里的 import 被识别', edges.some((e) => e.startsWith('src/bom.ts')), JSON.stringify(edges));
    check('CRLF 文件里的 import 被识别', edges.some((e) => e.startsWith('src/crlf.ts')));
    check('无末尾换行的文件被识别', edges.some((e) => e.startsWith('src/noeol.ts')));
    const bom = report.nodes.find((n) => n.id === 'src/bom.ts');
    check('BOM 不计入行数异常', bom && bom.lines === 2, `lines=${bom?.lines}`);
  }
}

// ---------------------------------------------------------------------------
// 7) 循环依赖跨越多个目录 + 规则检查依然可用
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'cross-cycle');
  await mk(join(repo, 'src', 'a'));
  await mk(join(repo, 'src', 'b'));
  await writeFile(join(repo, 'src', 'a', 'x.ts'), "import { y } from '../b/y';\nexport const x = y;\n", 'utf8');
  await writeFile(join(repo, 'src', 'b', 'y.ts'), "import { x } from '../a/x';\nexport const y = x;\n", 'utf8');

  const { report } = await analyze(repo);
  check('跨目录环被识别',
    report && report.cycles.length === 1 && report.cycles[0].length === 2,
    JSON.stringify(report?.cycles));

  const rules = join(work, 'cycle-rules.json');
  await writeFile(rules, JSON.stringify({
    schemaVersion: 1,
    rules: [{ id: 'no-a-b', from: 'src/a/**', to: 'src/b/**', forbidden: true, message: 'a 不该依赖 b' }],
  }), 'utf8');
  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  check('环上的违规仍然能被规则抓到',
    r.code === 1 && JSON.parse(r.stdout).violations.length === 1, `exit=${r.code}`);
}

// ---------------------------------------------------------------------------
// 8) --ignore 的边界：否定、锚定、目录前缀
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'ignores');
  await mk(join(repo, 'src', 'keep'));
  await mk(join(repo, 'lib'));
  await mk(join(repo, 'packages', 'x', 'src'));
  await writeFile(join(repo, 'src', 'keep', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(join(repo, 'lib', 'b.ts'), 'export const b = 1;\n', 'utf8');
  await writeFile(join(repo, 'packages', 'x', 'src', 'c.ts'), 'export const c = 1;\n', 'utf8');

  const base = await analyze(repo);
  check('ignore 基准：3 个文件都在图里', base.report.stats.nodeCount === 3, `nodeCount=${base.report.stats.nodeCount}`);

  const byDir = await analyze(repo, ['--ignore', 'lib/']);
  check('--ignore 目录名（带斜杠）', byDir.report.nodes.every((n) => !n.id.startsWith('lib/')),
    JSON.stringify(byDir.report.nodes.map((n) => n.id)));

  const byGlob = await analyze(repo, ['--ignore', '**/src/**']);
  check('--ignore 使用 ** 通配', byGlob.report.nodes.every((n) => !n.id.includes('/src/')),
    JSON.stringify(byGlob.report.nodes.map((n) => n.id)));

  const byStar = await analyze(repo, ['--ignore', 'packages/*/src/c.ts']);
  check('--ignore 使用单星通配', byStar.report.nodes.every((n) => n.id !== 'packages/x/src/c.ts'),
    JSON.stringify(byStar.report.nodes.map((n) => n.id)));
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
  process.exit(1);
}
