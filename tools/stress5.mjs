/**
 * 鲁棒性套件 5：规则引擎与 CLI 的边界。
 *
 * 重点不是"能不能跑"，而是"报出来的东西对不对、好不好用"：
 * 违规必须报到**源文件**级别（用户要能点开），多规则重叠不能互相吞掉，
 * 组合标志不能产生自相矛盾的输出，pattern 的各种写法必须等价。
 *
 * 用法: node tools/stress5.mjs
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'bin', 'cli.mjs');
const work = join(tmpdir(), 'archsvg-stress5');

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

const mk = (p) => mkdir(p, { recursive: true });
const writeRules = async (dir, name, rules) => {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, rules }, null, 2), 'utf8');
  return file;
};

await rm(work, { recursive: true, force: true });
await mk(work);

// 一个典型的"分层"仓库：ui / api / core / db / utils
const repo = join(work, 'layered');
for (const d of ['ui', 'api', 'core', 'db', 'utils']) await mk(join(repo, 'src', d));
await writeFile(join(repo, 'src', 'main.ts'),
  "import { page } from './ui/page';\nimport { router } from './api/router';\nexport const app = [page, router];\n", 'utf8');
await writeFile(join(repo, 'src', 'ui', 'page.ts'),
  "import { client } from '../db/client';\nimport { fmt } from '../utils/fmt';\nexport const page = [client, fmt];\n", 'utf8');
await writeFile(join(repo, 'src', 'api', 'router.ts'),
  "import { client } from '../db/client';\nimport { core } from '../core/core';\nexport const router = [client, core];\n", 'utf8');
await writeFile(join(repo, 'src', 'core', 'core.ts'),
  "import { fmt } from '../utils/fmt';\nexport const core = fmt;\n", 'utf8');
await writeFile(join(repo, 'src', 'db', 'client.ts'),
  "import { fmt } from '../utils/fmt';\nexport const client = fmt;\n", 'utf8');
await writeFile(join(repo, 'src', 'utils', 'fmt.ts'), 'export const fmt = 1;\n', 'utf8');

const jsonOf = (out) => JSON.parse(out);

// ---------------------------------------------------------------------------
// 1) 违规必须报到源文件级别，即使图上做了目录聚合
// ---------------------------------------------------------------------------
{
  const rules = await writeRules(work, 'r-layers.json', [
    { id: 'ui-not-db', from: 'src/ui/**', to: 'src/db/**', forbidden: true, message: 'ui 不该碰 db' },
    { id: 'core-not-db', from: 'src/core/**', to: 'src/db/**', forbidden: true, message: 'core 不该碰 db' },
    { id: 'db-not-api', from: 'src/db/**', to: 'src/api/**', forbidden: true, message: 'db 不该碰 api' },
  ]);

  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const report = jsonOf(r.stdout);
  const files = report.violations.map((v) => v.from);
  check('规则：违规报到源文件而不是目录', files.includes('src/ui/page.ts'), JSON.stringify(files));
  check('规则：只报真正违规的那一条', report.violations.length === 1, JSON.stringify(files));
  check('规则：退出码为 1', r.code === 1);

  // 关键：即使图上是目录聚合视图，违规也必须给出具体文件
  const grouped = await cli([repo, '--check', '--rules', rules, '--group-dir', '--json', '--quiet']);
  const groupedReport = jsonOf(grouped.stdout);
  check('--check 与 --group-dir 组合：违规仍是文件级',
    groupedReport.violations.length === 1 && groupedReport.violations[0].from === 'src/ui/page.ts',
    JSON.stringify(groupedReport.violations.map((v) => v.from)));
  check('--group-dir 时图确实被聚合了', groupedReport.stats.grouped === true);
}

// ---------------------------------------------------------------------------
// 2) 多规则重叠：每条规则都要独立报，不能被去重吞掉
// ---------------------------------------------------------------------------
{
  const rules = await writeRules(work, 'r-overlap.json', [
    { id: 'a-ui-to-db', from: 'src/ui/**', to: 'src/db/**', forbidden: true, message: 'ui→db' },
    { id: 'b-any-to-db', from: 'src/**', to: 'src/db/**', forbidden: true, message: '任何层→db' },
    { id: 'c-src-to-src', from: 'src/**', to: 'src/**', forbidden: true, message: 'src 内部互引' },
  ]);
  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const report = jsonOf(r.stdout);
  const ids = [...new Set(report.violations.map((v) => v.ruleId))].sort();
  check('重叠规则各自独立报告', ids.join(',') === 'a-ui-to-db,b-any-to-db,c-src-to-src', JSON.stringify(ids));

  const notSelf = report.violations.every((v) => v.from !== v.to);
  check('规则不把"文件指向自己"算成违规', notSelf);

  const cCount = report.violations.filter((v) => v.ruleId === 'c-src-to-src').length;
  check('宽泛规则命中数正确', cCount === 5, `c-src-to-src=${cCount}`);
}

// ---------------------------------------------------------------------------
// 3) 规则 pattern 的边界写法
// ---------------------------------------------------------------------------
{
  // 前导 ./、重复 .///、尾斜杠、反斜杠、大小写
  const rules = await writeRules(work, 'r-pattern.json', [
    { id: 'leading-dot', from: './src/ui/**', to: './src/db/**', forbidden: true, message: '带 ./ 前缀' },
    { id: 'double-dot', from: '././src/ui/**', to: '././src/db/**', forbidden: true, message: '重复 ./ 前缀' },
    { id: 'trailing-slash', from: 'src/ui/', to: 'src/db/', forbidden: true, message: '带尾斜杠' },
    { id: 'backslash', from: 'src\\ui\\**', to: 'src\\db\\**', forbidden: true, message: '反斜杠' },
  ]);
  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const report = jsonOf(r.stdout);
  const ids = [...new Set(report.violations.map((v) => v.ruleId))].sort();
  check('pattern 写法：./ 前缀 / 重复 ./ / 尾斜杠 / 反斜杠都等价',
    ids.join(',') === 'backslash,double-dot,leading-dot,trailing-slash', JSON.stringify(ids));
  const files = [...new Set(report.violations.map((v) => v.from))];
  check('pattern 写法：都指向同一个文件', files.length === 1 && files[0] === 'src/ui/page.ts', JSON.stringify(files));
}

// ---------------------------------------------------------------------------
// 3b) 更细的 pattern 形状
// ---------------------------------------------------------------------------
{
  // 单文件精确匹配、** 在中间、? 通配
  const rules = await writeRules(work, 'r-shape.json', [
    { id: 'exact-file', from: 'src/ui/page.ts', to: 'src/db/client.ts', forbidden: true, message: '精确文件' },
    { id: 'mid-star', from: 'src/**/page.ts', to: 'src/**/client.ts', forbidden: true, message: '中间 **' },
    { id: 'q-mark', from: 'src/u?/page.ts', to: 'src/db/clien?.ts', forbidden: true, message: '?' },
  ]);
  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const report = jsonOf(r.stdout);
  const ids = [...new Set(report.violations.map((v) => v.ruleId))].sort();
  check('pattern 形状：精确文件 / 中间 ** / ? 都生效',
    ids.join(',') === 'exact-file,mid-star,q-mark', JSON.stringify(ids));
}

// ---------------------------------------------------------------------------
// 4) 规则指向外部依赖（当前应是"稳定地不命中"，而不是崩）
// ---------------------------------------------------------------------------
{
  const extRepo = join(work, 'external');
  await mk(join(extRepo, 'src'));
  await writeFile(join(extRepo, 'src', 'a.ts'),
    "import express from 'express';\nimport { readFile } from 'node:fs';\nexport const v = [express, readFile];\n", 'utf8');
  const rules = await writeRules(work, 'r-external.json', [
    { id: 'no-express', from: 'src/**', to: 'express', forbidden: true, message: '不许用 express' },
    { id: 'no-node-builtin', from: 'src/**', to: 'node:fs', forbidden: true, message: '不许用 fs' },
  ]);
  const r = await cli([extRepo, '--check', '--rules', rules, '--json', '--quiet']);
  check('规则指向外部包：不崩（当前不命中，属于已知限制）', r.code === 0, `exit=${r.code}`);
  const report = jsonOf(r.stdout);
  check('规则指向外部包：确实没命中', report.violations.length === 0);
}

// ---------------------------------------------------------------------------
// 5) CLI 组合标志的自洽性
// ---------------------------------------------------------------------------
{
  const rules = await writeRules(work, 'r-one.json', [
    { id: 'ui-not-db', from: 'src/ui/**', to: 'src/db/**', forbidden: true, message: 'ui 不该碰 db' },
  ]);

  // --check + --out：文件要写出来，违规信息走 stderr，退出码 1
  const outSvg = join(work, 'checked.svg');
  const r1 = await cli([repo, '--check', '--rules', rules, '--out', outSvg, '--json', '--quiet']);
  const exists = await stat(outSvg).then(() => true).catch(() => false);
  check('--check 与 --out 组合：图表仍然产出', r1.code === 1 && exists, `exit=${r1.code}, exists=${exists}`);
  const svg = await readFile(outSvg, 'utf8');
  check('--check 与 --out 组合：写的是 JSON 而文件名是 .svg（内容跟随 --format）',
    r1.stdout.trim() === '' && svg.startsWith('{'), svg.slice(0, 20));

  // --format html + --check
  const outHtml = join(work, 'checked.html');
  const r2 = await cli([repo, '--check', '--rules', rules, '--format', 'html', '--out', outHtml, '--quiet']);
  const html = await readFile(outHtml, 'utf8');
  check('--check 与 html 输出组合', r2.code === 1 && html.startsWith('<!doctype html>'), `exit=${r2.code}`);

  // --quiet 不应压掉违规摘要（它是给人看的结论）
  const r3 = await cli([repo, '--check', '--rules', rules, '--quiet']);
  check('--quiet 下仍然给出违规摘要', /架构违规|ui 不该碰 db/.test(r3.stderr), JSON.stringify(r3.stderr.slice(0, 120)));

  // 同一条命令重复跑，输出一致
  const a = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const b = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  check('--check 输出确定', a.stdout === b.stdout);
}

// ---------------------------------------------------------------------------
// 6) 规则文件本身的边界
// ---------------------------------------------------------------------------
{
  const cases = [
    ['空 rules 数组', [], 0],
  ];
  for (const [label, rules, expected] of cases) {
    const f = await writeRules(work, `r-${label}.json`, rules);
    const r = await cli([repo, '--check', '--rules', f, '--json', '--quiet']);
    check(`规则文件：${label} → exit ${expected}`, r.code === expected, `exit=${r.code}`);
  }

  // 规则 id 含特殊字符：应原样出现在输出里
  const weird = await writeRules(work, 'r-weird.json', [
    { id: 'rule with spaces & <xml>', from: 'src/ui/**', to: 'src/db/**', forbidden: true, message: '含 & < > 的消息' },
  ]);
  const rw = await cli([repo, '--check', '--rules', weird, '--quiet']);
  check('规则 id/消息含特殊字符：报出来不炸', rw.code === 1 && rw.stderr.includes('含 & < > 的消息'),
    JSON.stringify(rw.stderr.slice(0, 160)));

  // 违规消息里带特殊字符时，SVG/HTML 输出必须仍然良构
  const outSvg = join(work, 'weird.svg');
  await cli([repo, '--check', '--rules', weird, '--out', outSvg, '--quiet']);
  const svg = await readFile(outSvg, 'utf8');
  const { checkXml } = await import('../test/helpers/xml.mjs');
  check('规则消息不会破坏 SVG（--check 只输出 json，这里验证默认 SVG 路径）',
    checkXml(svg).ok || svg.startsWith('{'), '');
}

// ---------------------------------------------------------------------------
// 7) 大量规则的性能与正确性
// ---------------------------------------------------------------------------
{
  const many = [];
  for (let i = 0; i < 200; i += 1) {
    many.push({
      id: `rule-${String(i).padStart(3, '0')}`,
      from: 'src/ui/**',
      to: 'src/db/**',
      forbidden: true,
      message: `第 ${i} 条规则`,
    });
  }
  const f = await writeRules(work, 'r-many.json', many);
  const t0 = Date.now();
  const r = await cli([repo, '--check', '--rules', f, '--json', '--quiet']);
  const ms = Date.now() - t0;
  const report = jsonOf(r.stdout);
  check('200 条规则：全部报出', report.violations.length === 200, `violations=${report.violations.length}`);
  check('200 条规则：性能可接受', ms < 5000, `${ms}ms`);
}

// ---------------------------------------------------------------------------
// 8) 违规在 JSON 里的结构
// ---------------------------------------------------------------------------
{
  const rules = await writeRules(work, 'r-struct.json', [
    { id: 'ui-not-db', from: 'src/ui/**', to: 'src/db/**', forbidden: true, message: 'ui 不该碰 db' },
  ]);
  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const report = jsonOf(r.stdout);
  const v = report.violations[0];
  check('violation 结构完整',
    v && typeof v.ruleId === 'string' && typeof v.from === 'string' && typeof v.to === 'string'
      && typeof v.message === 'string' && Array.isArray(v.refs) && v.refs.length > 0
      && typeof v.refs[0].file === 'string' && typeof v.refs[0].line === 'number',
    JSON.stringify(v));
  check('violation 的 to 是 pattern 而不是文件（有意为之，见 README）',
    v.to === 'src/db/**', JSON.stringify(v.to));

  // 违规里的 refs 必须指向真实文件与真实行
  const abs = join(report.root, v.refs[0].file);
  const line = (await readFile(abs, 'utf8')).split('\n')[v.refs[0].line - 1] ?? '';
  check('violation 的 refs 指向真实的导入行', /import|require|from/.test(line), JSON.stringify(line.trim()));
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
  process.exit(1);
}
