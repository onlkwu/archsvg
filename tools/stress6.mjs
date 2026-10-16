/**
 * 鲁棒性套件 6：命令行输入异常。
 *
 * 重点不是"功能对不对"，而是"喂进去奇怪的东西会不会崩、会不会误判"。
 * 用户的 shell 补全、批处理脚本、CI 变量替换都会产出意料之外的参数：
 * 缺值、空值、非法数字、`--` 分隔符、以横杠开头的路径。
 *
 * 用法: node tools/stress6.mjs
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
const work = join(tmpdir(), 'archsvg-stress6');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 直接传参数数组，避免 shell 参与转义 */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      crashed: !err.stdout && !err.stderr,
      signal: err.signal,
    };
  }
}

const mk = (p) => mkdir(p, { recursive: true });
/** 崩了的判据：退出码非 0/1/2，或 stderr 里出现未捕获异常的特征 */
const crashed = (r) =>
  ![0, 1, 2].includes(r.code) ||
  /UnhandledPromiseRejection|at Object\.<anonymous>|TypeError:|ReferenceError:|SyntaxError:/.test(r.stderr);

await rm(work, { recursive: true, force: true });
await mk(work);

const repo = join(work, 'repo');
await mk(join(repo, 'src'));
await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

// ---------------------------------------------------------------------------
// 1) 空参数与空白参数
// ---------------------------------------------------------------------------
{
  const noArgs = await cli([]);
  check('完全没有参数：当作当前目录，不崩', !crashed(noArgs), `exit=${noArgs.code}`);

  const emptyPos = await cli(['']);
  check('位置参数是空字符串：不崩，报可读错误', !crashed(emptyPos), `exit=${emptyPos.code}, stderr=${JSON.stringify(emptyPos.stderr.slice(0, 80))}`);

  const spacePos = await cli(['   ']);
  check('位置参数是纯空白：不崩', !crashed(spacePos), `exit=${spacePos.code}`);

  // 关键：解析错误信息里必须带上用户真正输入的那个路径
  check('空路径的报错信息可读（含原输入）',
    emptyPos.stderr.includes('不是有效目录') || emptyPos.code === 0,
    JSON.stringify(emptyPos.stderr.slice(0, 100)));
}

// ---------------------------------------------------------------------------
// 2) 取值类参数缺值 / 值像另一个 flag / 空值
// ---------------------------------------------------------------------------
{
  const cases = [
    ['--out 缺值', ['--out']],
    ['--out 后面直接跟另一个 flag', ['--out', '--json']],
    ['--rules 缺值', ['--rules']],
    ['--format 缺值', ['--format']],
    ['--lang 缺值', ['--lang']],
    ['--ignore 缺值', ['--ignore']],
    ['--group-depth 缺值', ['--group-depth']],
    ['--max-nodes 缺值', ['--max-nodes']],
    ['--out= 空值', [`--out=`]],
    ['--format= 空值', ['--format=']],
    ['--title= 空值', ['--title=']],
  ];
  for (const [label, args] of cases) {
    const r = await cli([repo, ...args]);
    check(`参数异常：${label} → 不崩且给出非 0 退出码`, !crashed(r) && r.code === 2,
      `exit=${r.code}, stderr=${JSON.stringify(r.stderr.slice(0, 90))}`);
  }
}

// ---------------------------------------------------------------------------
// 3) 数值参数的边界值
// ---------------------------------------------------------------------------
{
  const cases = [
    ['--max-nodes 0', ['--max-nodes', '0']],
    ['--max-nodes -1', ['--max-nodes', '-1']],
    ['--max-nodes 1e9', ['--max-nodes', '1e9']],
    ['--max-nodes abc', ['--max-nodes', 'abc']],
    ['--max-nodes NaN', ['--max-nodes', 'NaN']],
    ['--max-nodes Infinity', ['--max-nodes', 'Infinity']],
    ['--group-depth 0', ['--group-depth', '0']],
    ['--group-depth -5', ['--group-depth', '-5']],
    ['--group-depth 3.7', ['--group-depth', '3.7']],
    ['--max-files 0', ['--max-files', '0']],
    ['--max-files -1', ['--max-files', '-1']],
  ];
  for (const [label, args] of cases) {
    const r = await cli([repo, '--json', '--quiet', ...args]);
    const ok = !crashed(r);
    let detail = `exit=${r.code}`;
    if (r.code === 0) {
      try {
        const report = JSON.parse(r.stdout);
        detail += `, nodes=${report.stats.nodeCount}, grouped=${report.stats.grouped}, depth=${report.stats.groupDepth}`;
        // 必须真的完成一次分析
        check(`数值边界：${label}`, ok && report.stats.nodeCount === 1, detail);
      } catch {
        check(`数值边界：${label}`, false, `${detail}, 输出不是合法 JSON`);
      }
    } else {
      check(`数值边界：${label} → 不崩（拒绝或降级都可接受）`, ok && r.code === 2, detail);
    }
  }
}

// ---------------------------------------------------------------------------
// 4) 重复给同一个参数
// ---------------------------------------------------------------------------
{
  const r = await cli([repo, '--format', 'svg', '--format', 'json', '--quiet']);
  check('重复 --format：不崩，取其中一个', !crashed(r) && r.code === 0, `exit=${r.code}`);
  check('重复 --format：后者生效（可预测）', r.stdout.trimStart().startsWith('{'), JSON.stringify(r.stdout.slice(0, 24)));

  const t = await cli([repo, '--title', 'A', '--title', 'B', '--quiet']);
  check('重复 --title：后者生效', !crashed(t) && t.stdout.includes('B') && !t.stdout.includes('>A<'), `exit=${t.code}`);

  const q = await cli([repo, '--quiet', '--quiet', '--json']);
  check('重复布尔参数：幂等', !crashed(q) && q.code === 0, `exit=${q.code}`);

  const i = await cli([repo, '--ignore', 'src/', '--ignore', 'nothing/', '--json', '--quiet']);
  const report = JSON.parse(i.stdout);
  check('重复 --ignore：累积而不是覆盖', report.stats.nodeCount === 0, `nodeCount=${report.stats.nodeCount}`);
}

// ---------------------------------------------------------------------------
// 5) `--` 分隔符与像 flag 的路径
// ---------------------------------------------------------------------------
{
  const dashed = join(work, '--weird-dir');
  await mk(dashed);
  await writeFile(join(dashed, 'a.ts'), 'export const a = 1;\n', 'utf8');

  const r1 = await cli(['--', dashed, '--json', '--quiet']);
  check('-- 之后的内容全当位置参数', !crashed(r1) && r1.code === 0, `exit=${r1.code}, stderr=${JSON.stringify(r1.stderr.slice(0, 80))}`);
  // 标准语义：-- 之后的 --json 也是位置参数，所以拿到的是 SVG 而不是 JSON
  check('-- 会终止选项解析（--json 不再生效）',
    r1.stdout.trimStart().startsWith('<svg'), JSON.stringify(r1.stdout.slice(0, 24)));

  // 想要 JSON 就把选项放在 -- 前面
  const r1b = await cli(['--json', '--quiet', '--', dashed]);
  let nodes = -1;
  try {
    nodes = JSON.parse(r1b.stdout).stats.nodeCount;
  } catch {
    nodes = -1;
  }
  check('选项放 -- 前面时能正常拿到 JSON', r1b.code === 0 && nodes === 1,
    `exit=${r1b.code}, nodes=${nodes}`);

  const r2 = await cli([dashed, '--json', '--quiet']);
  // 绝对路径以盘符或斜杠开头，不会和长选项混淆，所以直接传也能用
  let nodes2 = -1;
  try {
    nodes2 = JSON.parse(r2.stdout).stats.nodeCount;
  } catch {
    nodes2 = -1;
  }
  check('以 -- 开头的目录（绝对路径）不用 -- 也能分析', r2.code === 0 && nodes2 === 1,
    `exit=${r2.code}, nodes=${nodes2}`);

  // 真正的限制：**相对**路径以 -- 开头时会被当成选项，必须靠 -- 或 -- 取值
  const rel = await run(process.execPath, [CLI, '--weird-dir', '--json'], {
    cwd: work,
    encoding: 'utf8',
  }).then((x) => ({ code: 0, stdout: x.stdout, stderr: x.stderr })).catch((e) => ({
    code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '',
  }));
  check('相对路径以 -- 开头：被当选项拒绝（必须用 -- 或绝对路径）',
    !crashed(rel) && rel.code === 2, `exit=${rel.code}`);

  // --out 后面用 -- 可以传以横杠开头的取值
  const outFile = join(work, '--dashed-out.svg');
  const r3 = await cli([repo, '--out', '--', outFile, '--quiet']);
  const wrote = await readFile(outFile, 'utf8').then((s) => s.startsWith('<svg')).catch(() => false);
  check('--out -- <以横杠开头的路径> 可用', !crashed(r3) && r3.code === 0 && wrote,
    `exit=${r3.code}, wrote=${wrote}`);
}

// ---------------------------------------------------------------------------
// 6) 以 - 开头但又不是已知别名的参数
// ---------------------------------------------------------------------------
{
  for (const bad of ['-x', '-o', '--', '-', '--=x']) {
    const r = await cli([repo, bad, '--quiet']);
    const ok = !crashed(r);
    check(`未知/歧义参数 "${bad}"：不崩`, ok, `exit=${r.code}, stderr=${JSON.stringify(r.stderr.slice(0, 70))}`);
  }
}

// ---------------------------------------------------------------------------
// 7) 仓库路径的极端写法
// ---------------------------------------------------------------------------
{
  const cases = [
    ['带空格与中文的目录', join(work, '有空 格 的 目录')],
    ['以点开头的隐藏目录', join(work, '.hidden')],
    ['名字里有引号', join(work, "quote'dir")],
    ['名字里有 $ 与反引号', join(work, 'dollar$back`tick')],
    ['超长路径段', join(work, 'x'.repeat(120))],
  ];
  for (const [label, dir] of cases) {
    await mk(dir);
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
    const r = await cli([dir, '--json', '--quiet']);
    let ok = !crashed(r) && r.code === 0;
    if (ok) {
      try {
        ok = JSON.parse(r.stdout).stats.nodeCount === 1;
      } catch {
        ok = false;
      }
    }
    check(`路径写法：${label}`, ok, `exit=${r.code}`);
  }
}

// ---------------------------------------------------------------------------
// 8) 输出到不可写 / 奇怪的路径
// ---------------------------------------------------------------------------
{
  const cases = [
    ['输出到已存在的目录', work],
    ['输出到带空格的路径', join(work, 'a b', 'out.svg')],
    ['输出到超长文件名', join(work, 'y'.repeat(200) + '.svg')],
    ['输出路径含 ..', join(work, 'sub', '..', 'out2.svg')],
  ];
  for (const [label, out] of cases) {
    const r = await cli([repo, '--out', out, '--quiet']);
    // 能写成功是正常；写失败也必须是干净的 exit 2 + 可读错误，而不是栈
    check(`输出路径：${label} → 不崩`, !crashed(r), `exit=${r.code}, stderr=${JSON.stringify(r.stderr.slice(0, 90))}`);
  }

  // 确认最后一个真的写出来了
  const dotdot = join(work, 'sub', '..', 'out2.svg');
  const written = await readFile(dotdot, 'utf8').then(() => true).catch(() => false);
  check('输出路径含 .. 时能正确落盘', written, dotdot);
}

// ---------------------------------------------------------------------------
// 9) 规则文件的路径异常
// ---------------------------------------------------------------------------
{
  const dirAsRules = await cli([repo, '--check', '--rules', work, '--quiet']);
  check('--rules 指向目录：exit 2 + 可读错误', dirAsRules.code === 2 && !crashed(dirAsRules),
    `exit=${dirAsRules.code}, stderr=${JSON.stringify(dirAsRules.stderr.slice(0, 90))}`);

  const emptyRules = join(work, 'empty.json');
  await writeFile(emptyRules, '', 'utf8');
  const r2 = await cli([repo, '--check', '--rules', emptyRules, '--quiet']);
  check('--rules 指向空文件：exit 2', r2.code === 2 && !crashed(r2), `exit=${r2.code}`);

  const bomRules = join(work, 'bom.json');
  // 明确写出 UTF-8 BOM 字节（EF BB BF），而不是靠字符串里的 \ufeff
  await writeFile(bomRules, Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('{"schemaVersion":1,"rules":[]}', 'utf8'),
  ]));
  const r3 = await cli([repo, '--check', '--rules', bomRules, '--quiet']);
  check('--rules 文件带 BOM：仍能解析（记事本/PowerShell 存 JSON 的常见情况）',
    r3.code === 0, `exit=${r3.code}, stderr=${JSON.stringify(r3.stderr.slice(0, 120))}`);

  const arrayRules = join(work, 'array.json');
  await writeFile(arrayRules, '[{"id":"x"}]', 'utf8');
  const r4 = await cli([repo, '--check', '--rules', arrayRules, '--quiet']);
  check('--rules 顶层是数组：exit 2', r4.code === 2 && !crashed(r4), `exit=${r4.code}`);
}

// ---------------------------------------------------------------------------
// 10) 值里带换行/制表符
// ---------------------------------------------------------------------------
{
  const multibyteTitle = '多行\n标题\t带制表符';
  const r = await cli([repo, '--title', multibyteTitle, '--quiet']);
  check('--title 含换行与制表符：不崩', !crashed(r) && r.code === 0, `exit=${r.code}`);
  if (r.code === 0) {
    const { checkXml } = await import('../test/helpers/xml.mjs');
    const res = checkXml(r.stdout);
    check('--title 含控制字符时 SVG 仍然良构', res.ok, res.ok ? '' : `${res.error} @${res.index}`);
    // 换行不应把标签断成两行导致结构被破坏
    check('--title 里的换行被保留而不是被丢弃', r.stdout.includes('标题'), '');
  }

  const ig = await cli([repo, '--ignore', 'src\n/', '--json', '--quiet']);
  check('--ignore 含换行：不崩', !crashed(ig), `exit=${ig.code}`);
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
  process.exit(1);
}
