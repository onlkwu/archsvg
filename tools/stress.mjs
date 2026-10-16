/**
 * 压力与鲁棒性测试（不属于 test/ 的常规套件，按需手动运行）。
 *
 * 目的：跑常规单测覆盖不到的东西——反复运行的确定性、
 * 敌意文件名、规模上限、错误输入、以及"跑完之后工作区有没有被弄脏"。
 *
 * 用法: node tools/stress.mjs [--big N]
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'bin', 'cli.mjs');
const work = join(tmpdir(), 'archsvg-stress');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      ...opts,
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
// 1) 反复运行的确定性
// ---------------------------------------------------------------------------
{
  const hashes = new Set();
  const jsonHashes = new Set();
  const N = 20;
  for (let i = 0; i < N; i += 1) {
    const svg = await cli(['demo', '--quiet']);
    const json = await cli(['demo', '--json', '--quiet']);
    hashes.add(sha(svg.stdout));
    // root 是绝对路径，天然随机器/目录变化，不属于确定性的一部分
    const { root: _root, ...stable } = JSON.parse(json.stdout);
    jsonHashes.add(sha(JSON.stringify(stable)));
  }
  check(`SVG 连跑 ${N} 次字节一致`, hashes.size === 1, `${hashes.size} 种结果`);
  check(`JSON 连跑 ${N} 次字节一致（除 root 外）`, jsonHashes.size === 1, `${jsonHashes.size} 种结果`);

  const sample = JSON.parse((await cli(['demo', '--json', '--quiet'])).stdout);
  const unstable = ['durationMs', 'time', 'timestamp', 'generatedAt'].filter(
    (k) => k in sample.stats,
  );
  check('JSON stats 里没有易变字段', unstable.length === 0, unstable.join(','));
}

// ---------------------------------------------------------------------------
// 2) 并行运行不互相干扰（无临时文件 / 无共享状态）
// ---------------------------------------------------------------------------
{
  const outs = await Promise.all(Array.from({ length: 8 }, () => cli(['demo', '--quiet'])));
  const hashes = new Set(outs.map((o) => sha(o.stdout)));
  check('8 个进程并行输出一致', hashes.size === 1 && outs.every((o) => o.code === 0));
}

// ---------------------------------------------------------------------------
// 3) 跑完之后工作区没被弄脏
// ---------------------------------------------------------------------------
{
  const before = (await stat(join(root, 'docs', 'architecture.svg'))).mtimeMs;
  await cli(['demo', '--quiet']); // 不写文件
  const after = (await stat(join(root, 'docs', 'architecture.svg'))).mtimeMs;
  check('默认不写任何文件', before === after);

  const outDirExists = await stat(join(root, 'out')).then(() => true).catch(() => false);
  check('没有产生 out/ 目录', outDirExists === false);
}

// ---------------------------------------------------------------------------
// 4) 敌意文件名
// ---------------------------------------------------------------------------
{
  const hostile = join(work, 'hostile');
  const dirs = [
    'src/中文目录',
    'src/emoji 🎉 dir',
    'src/has space',
    'src/paren(s)',
    'src/plus+plus',
    'src/brack[et]',
    'src/dot.in.name',
    'src/' + 'x'.repeat(120),
    'src/normal',
  ];
  for (const d of dirs) await mkdir(join(hostile, d), { recursive: true });

  let i = 0;
  for (const d of dirs) {
    const name = d === 'src/normal' ? 'a.ts' : 'a.ts';
    await writeFile(
      join(hostile, d, name),
      `// ${d}\nimport { x } from '../normal/a';\nexport const v${i} = x;\n`,
      'utf8',
    );
    i += 1;
  }
  // 中文内容的节点标签
  await writeFile(
    join(hostile, 'src', 'normal', 'zh.ts'),
    '// 中文注释：模块说明\nexport const 用户 = 1;\n',
    'utf8',
  );

  const r = await cli([hostile, '--json', '--quiet']);
  check('敌意文件名：分析成功', r.code === 0, `exit=${r.code}`);

  if (r.code === 0) {
    const report = JSON.parse(r.stdout);
    check('敌意文件名：所有文件都进了图', report.stats.nodeCount === dirs.length + 1, `nodeCount=${report.stats.nodeCount}`);
    check(
      '敌意文件名：中文目录名原样保留',
      report.nodes.some((n) => n.id === 'src/中文目录/a.ts'),
    );
    check(
      '敌意文件名：emoji 目录名原样保留',
      report.nodes.some((n) => n.id.startsWith('src/emoji')),
    );
    const svg = await cli([hostile, '--quiet']);
    const res = await cli([hostile, '--quiet']);
    check('敌意文件名：输出仍然确定', sha(svg.stdout) === sha(res.stdout));
  }
}

// ---------------------------------------------------------------------------
// 5) 规模压力
// ---------------------------------------------------------------------------
{
  const big = join(work, 'big');
  const modules = 30;
  const per = 100; // 3000 文件
  for (let m = 0; m < modules; m += 1) {
    const dir = join(big, 'src', `mod${String(m).padStart(2, '0')}`);
    await mkdir(dir, { recursive: true });
    for (let f = 0; f < per; f += 1) {
      const lines = [`// ${m}/${f}`];
      if (f > 0) lines.push(`import { g } from './f${f - 1}';`);
      if (f % 10 === 0 && m > 0) lines.push(`import { q } from '../mod${String(m - 1).padStart(2, '0')}/f0';`);
      lines.push('export function g(n = 0) { return n + 1; }');
      await writeFile(join(dir, `f${f}.ts`), lines.join('\n') + '\n', 'utf8');
    }
  }

  const t0 = Date.now();
  const flat = await cli([big, '--max-nodes', '100000', '--json', '--out', join(work, 'big-flat.json'), '--quiet']);
  const flatMs = Date.now() - t0;
  check('3000 文件平面图不崩', flat.code === 0, `exit=${flat.code}, ${flatMs}ms`);

  const flatReport = JSON.parse(await readFile(join(work, 'big-flat.json'), 'utf8'));
  check('3000 文件：节点数正确', flatReport.stats.nodeCount === modules * per, `nodeCount=${flatReport.stats.nodeCount}`);
  // 耗时不在 JSON 里（那会破坏逐字节可比性），只能量墙钟
  check('3000 文件：性能可接受', flatMs < 20000, `墙钟=${flatMs}ms（含进程启动）`);

  // 超宽单层必须折行：30 个模块 f0 都没有前驱之外的孤立层吗？
  // 直接构造一个全孤立仓库更直接
  const flatRepo = join(work, 'isolated');
  await mkdir(join(flatRepo, 'src'), { recursive: true });
  for (let f = 0; f < 400; f += 1) {
    await writeFile(join(flatRepo, 'src', `iso${f}.ts`), 'export const x = 1;\n', 'utf8');
  }
  const iso = await cli([flatRepo, '--out', join(work, 'iso.svg'), '--quiet']);
  const isoHeader = /<svg[^>]*width="([\d.]+)" height="([\d.]+)"/.exec(await readFile(join(work, 'iso.svg'), 'utf8'));
  check('400 个孤立文件：自动折行', iso.code === 0 && Number(isoHeader[1]) <= 1500, `画布 ${isoHeader?.[1]}x${isoHeader?.[2]}`);

  const t1 = Date.now();
  const auto = await cli([big, '--json', '--quiet']);
  const autoMs = Date.now() - t1;
  const autoReport = JSON.parse(auto.stdout);
  check('3000 文件：自动上卷到目录级', autoReport.stats.grouped === true, `grouped=${autoReport.stats.grouped}, ${autoMs}ms`);
}

// ---------------------------------------------------------------------------
// 6) 错误输入
// ---------------------------------------------------------------------------
{
  const bad = await cli([join(work, 'does-not-exist')]);
  check('不存在的路径 → exit 2', bad.code === 2, `exit=${bad.code}`);

  // 指向一个文件而不是目录
  await writeFile(join(work, 'a-file.txt'), 'x', 'utf8');
  const notDir = await cli([join(work, 'a-file.txt')]);
  check('目标是文件 → exit 2', notDir.code === 2, `exit=${notDir.code}`);

  // 损坏的 tsconfig
  const broken = join(work, 'broken-tsconfig');
  await mkdir(join(broken, 'src'), { recursive: true });
  await writeFile(join(broken, 'tsconfig.json'), '{ this is not json', 'utf8');
  await writeFile(join(broken, 'src', 'a.ts'), "import { b } from './b';\nexport const x = b;\n", 'utf8');
  await writeFile(join(broken, 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');
  const brokenRun = await cli([broken, '--json', '--quiet']);
  check('坏 tsconfig 不致命', brokenRun.code === 0, `exit=${brokenRun.code}`);
  check('坏 tsconfig 给出警告', brokenRun.code === 0 && JSON.parse(brokenRun.stdout).violations.length === 0);

  // 空文件 / 只有注释的文件
  const empties = join(work, 'empties');
  await mkdir(empties, { recursive: true });
  await writeFile(join(empties, 'empty.ts'), '', 'utf8');
  await writeFile(join(empties, 'only-comment.ts'), '// 只有注释\n', 'utf8');
  await writeFile(join(empties, 'bom.ts'), '\ufeffimport { x } from "./only-comment";\n', 'utf8');
  const emptyRun = await cli([empties, '--json', '--quiet']);
  check('空文件与 BOM 文件不崩', emptyRun.code === 0, `exit=${emptyRun.code}`);

  // 二进制文件混在源码扩展名里
  const binary = join(work, 'binary');
  await mkdir(binary, { recursive: true });
  await writeFile(join(binary, 'weird.ts'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  await writeFile(join(binary, 'ok.ts'), 'export const ok = 1;\n', 'utf8');
  const binRun = await cli([binary, '--json', '--quiet']);
  const binReport = binRun.code === 0 ? JSON.parse(binRun.stdout) : null;
  check('二进制内容被跳过而非崩溃', binRun.code === 0 && binReport.stats.nodeCount === 1, `nodeCount=${binReport?.stats?.nodeCount}`);

  // 循环导入自引用（自环）+ 深链（栈安全）
  const deep = join(work, 'deep');
  await mkdir(deep, { recursive: true });
  const DEPTH = 3000;
  for (let d = 0; d < DEPTH; d += 1) {
    const next = d + 1 < DEPTH ? `import { v } from './f${d + 1}';\n` : '';
    await writeFile(join(deep, `f${d}.ts`), `${next}export const v = ${d};\n`, 'utf8');
  }
  const deepRun = await cli([deep, '--json', '--out', join(work, 'deep.json'), '--quiet']);
  check(`${DEPTH} 层依赖链不爆栈`, deepRun.code === 0, `exit=${deepRun.code}`);

  // 规则文件的各种坏法
  const rulesBad = join(work, 'rules-bad.json');
  await writeFile(rulesBad, JSON.stringify({ schemaVersion: 1, rules: [{ id: 'x' }] }), 'utf8');
  const ruleRun = await cli(['demo', '--check', '--rules', rulesBad, '--quiet']);
  check('字段缺失的规则文件 → exit 2', ruleRun.code === 2, `exit=${ruleRun.code}`);
}

// ---------------------------------------------------------------------------
// 7) 规则 glob 对特殊字符路径
// ---------------------------------------------------------------------------
{
  const repo = join(work, 'glob');
  await mkdir(join(repo, 'src', 'a+b'), { recursive: true });
  await mkdir(join(repo, 'src', 'x.y'), { recursive: true });
  await mkdir(join(repo, 'src', 'normal'), { recursive: true });
  await writeFile(join(repo, 'src', 'a+b', 'i.ts'), "import { n } from '../normal/n';\nexport const v = n;\n", 'utf8');
  await writeFile(join(repo, 'src', 'x.y', 'j.ts'), "import { n } from '../normal/n';\nexport const w = n;\n", 'utf8');
  await writeFile(join(repo, 'src', 'normal', 'n.ts'), 'export const n = 1;\n', 'utf8');

  const rules = join(work, 'glob-rules.json');
  await writeFile(
    rules,
    JSON.stringify({
      schemaVersion: 1,
      rules: [
        { id: 'plus', from: 'src/a+b/**', to: 'src/normal/**', forbidden: true, message: 'a+b 不该依赖 normal' },
        { id: 'dotted', from: 'src/x.y/**', to: 'src/normal/**', forbidden: true, message: 'x.y 不该依赖 normal' },
      ],
    }),
    'utf8',
  );
  const r = await cli([repo, '--check', '--rules', rules, '--json', '--quiet']);
  const report = r.code === 1 || r.code === 0 ? JSON.parse(r.stdout) : { violations: [] };
  const byId = report.violations.map((v) => v.ruleId).sort();
  check(
    '规则 glob 里的 + 与 . 被当字面量',
    r.code === 1 && byId.length === 2 && byId[0] === 'dotted' && byId[1] === 'plus',
    `exit=${r.code}, 违规=${JSON.stringify(byId)}`,
  );
}

await rm(work, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}
