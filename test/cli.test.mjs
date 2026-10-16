import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { checkXml } from './helpers/xml.mjs';
import { fixture } from './helpers/fixtures.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'bin', 'cli.mjs');

/**
 * 跑 CLI 并拿到退出码 + 两个流。
 * 注意不能直接用 promisify 的返回值判断退出码，必须显式捕获 error。
 */
async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      cwd: join(here, '..'),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'archsvg-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const UI_RULE = {
  schemaVersion: 1,
  rules: [
    {
      id: 'ui-not-db',
      from: 'src/ui/**',
      to: 'src/db/**',
      forbidden: true,
      message: 'ui 层不应直接依赖 db 层',
    },
  ],
};

async function writeRules(dir, name, content) {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(content), 'utf8');
  return file;
}

test('--help 输出用法且退出码 0', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('用法'));
  assert.ok(r.stdout.includes('--check'));
});

test('--version 输出版本', async () => {
  const r = await runCli(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^archsvg \d+\.\d+\.\d+/);
});

test('默认输出 SVG 到 stdout，且是良构 XML', async () => {
  const r = await runCli([fixture('ts-app'), '--quiet']);
  assert.equal(r.code, 0);
  const res = checkXml(r.stdout);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
});

test('--format json 输出可解析的报告', async () => {
  const r = await runCli([fixture('ts-app'), '--format', 'json', '--quiet']);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.nodes.length > 0);
  assert.ok(report.stats.nodeCount > 0);
  assert.ok(report.edges.every((e) => Array.isArray(e.refs)));
});

test('--json 是 --format json 的等价写法', async () => {
  const r = await runCli([fixture('ts-app'), '--json', '--quiet']);
  assert.equal(r.code, 0);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
});

test('--out 写文件，stdout 保持干净', async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, 'arch.svg');
    const r = await runCli([fixture('ts-app'), '--out', out, '--quiet']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), '');
    const svg = await readFile(out, 'utf8');
    assert.ok(svg.startsWith('<svg'));
    const res = checkXml(svg);
    assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
  });
});

test('--out 自动创建不存在的目录', async () => {
  await withTempDir(async (dir) => {
    const out = join(dir, 'nested', 'deep', 'arch.svg');
    const r = await runCli([fixture('clean-app'), '--out', out, '--quiet']);
    assert.equal(r.code, 0);
    const svg = await readFile(out, 'utf8');
    assert.ok(svg.includes('<svg'));
  });
});

test('--format html 产出完整 HTML 文档', async () => {
  const r = await runCli([fixture('ts-app'), '--format', 'html', '--quiet']);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.startsWith('<!doctype html>'));
  assert.ok(r.stdout.includes('</html>'));
});

test('--quiet 不吞掉 --check 的结论（结论不是闲聊）', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', UI_RULE);
    const r = await runCli([fixture('ts-app'), '--check', '--rules', rules, '--quiet']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /架构违规/, '检查结论必须出现在 stderr');
    assert.match(r.stderr, /ui-not-db/, '违规规则 id 必须出现在 stderr');
    assert.match(r.stderr, /src\/ui\/page\.ts:2/, '必须给出文件与行号');
  });
});

test('--quiet 不吞掉 --check 的通过结论', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', UI_RULE);
    const r = await runCli([fixture('clean-app'), '--check', '--rules', rules, '--quiet']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /架构检查通过/);
  });
});

test('--quiet 仍会输出真正的警告（否则无法排查）', async () => {
  await withTempDir(async (dir) => {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    // 相对路径解析不到会产生 unresolved 警告
    await writeFile(join(repo, 'src', 'a.ts'), "import { x } from './missing';\nexport const y = x;\n", 'utf8');
    const r = await runCli([repo, '--quiet', '--json']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /warning \[unresolved-import\]/, `实际 stderr: ${JSON.stringify(r.stderr)}`);
    // 但纯信息性的摘要应该被压掉
    assert.equal(/模块 \d+ 个/.test(r.stderr), false, '--quiet 应压掉统计摘要');
  });
});

test('--check 与 --group-dir 组合时违规仍是文件级', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', UI_RULE);
    const r = await runCli([fixture('ts-app'), '--check', '--rules', rules, '--group-dir', '--json', '--quiet']);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.stats.grouped, true, '图应被聚合');
    assert.equal(report.violations[0].from, 'src/ui/page.ts', '违规必须报到源文件');
  });
});

test('规则 pattern 带 ./ 前缀时依然生效', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', {
      schemaVersion: 1,
      rules: [
        {
          id: 'ui-not-db',
          from: './src/ui/**',
          to: './src/db/**',
          forbidden: true,
          message: 'ui 层不应直接依赖 db 层',
        },
      ],
    });
    const r = await runCli([fixture('ts-app'), '--check', '--rules', rules, '--json', '--quiet']);
    assert.equal(r.code, 1, '带 ./ 的 pattern 不该静默失效');
    assert.equal(JSON.parse(r.stdout).violations.length, 1);
  });
});

test('同一条命令跑两次输出字节一致（确定性）', async () => {
  const a = await runCli([fixture('ts-app'), '--quiet']);
  const b = await runCli([fixture('ts-app'), '--quiet']);
  assert.equal(a.stdout, b.stdout);
});

test('--check：有违规时退出码 1 并报出文件行号', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', UI_RULE);
    const r = await runCli([fixture('ts-app'), '--check', '--rules', rules]);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('src/ui/page.ts:2'), r.stderr);
    assert.ok(r.stderr.includes('ui 层不应直接依赖 db 层'));
  });
});

test('--check：干净仓库退出码 0 且报告通过', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', UI_RULE);
    const r = await runCli([fixture('clean-app'), '--check', '--rules', rules]);
    assert.equal(r.code, 0);
    assert.ok(r.stderr.includes('架构检查通过'));
  });
});

test('--check 不带 --rules 时退出码 2', async () => {
  const r = await runCli([fixture('ts-app'), '--check']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('--rules'));
});

test('规则文件非法时退出码 2', async () => {
  await withTempDir(async (dir) => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{ nope', 'utf8');
    const r = await runCli([fixture('ts-app'), '--check', '--rules', bad]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('规则文件'));
  });
});

test('规则文件 schemaVersion 不对时退出码 2', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', { schemaVersion: 7, rules: [] });
    const r = await runCli([fixture('ts-app'), '--check', '--rules', rules]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes('schemaVersion'));
  });
});

test('--json 与 --check 组合：违规出现在报告里且退出码 1', async () => {
  await withTempDir(async (dir) => {
    const rules = await writeRules(dir, 'rules.json', UI_RULE);
    const r = await runCli([fixture('ts-app'), '--check', '--rules', rules, '--json', '--quiet']);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].ruleId, 'ui-not-db');
    assert.deepEqual(report.violations[0].refs, [{ file: 'src/ui/page.ts', line: 2 }]);
  });
});

test('不存在的路径退出码 2 且报错可读', async () => {
  const r = await runCli([join(here, 'no-such-dir-xyz')]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('不是有效目录'));
});

test('未知参数退出码 2', async () => {
  const r = await runCli([fixture('ts-app'), '--nope']);
  assert.equal(r.code, 2);
});

test('非法 --format 退出码 2', async () => {
  const r = await runCli([fixture('ts-app'), '--format', 'pdf']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('不支持的 --format'));
});

test('--group-dir 让图变成模块级视图', async () => {
  const r = await runCli([fixture('ts-app'), '--group-dir', '--json', '--quiet']);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.stats.grouped, true);
  assert.equal(report.stats.groupDepth, 2);
});

test('--lang 过滤掉其他语言', async () => {
  const r = await runCli([fixture('ts-app'), '--lang', 'py', '--json', '--quiet']);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.stdout);
  assert.equal(report.stats.nodeCount, 0);
});

test('空仓库：退出码 0 并给出提示', async () => {
  const r = await runCli([fixture('empty-app')]);
  assert.equal(r.code, 0);
  assert.ok(r.stderr.includes('没有发现可分析的源文件'));
});

test('--strict：存在无法解析的导入时退出码非 0', async () => {
  await withTempDir(async (dir) => {
    // 造一个引用了不存在模块的仓库
    const repo = join(dir, 'repo');
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, 'a.ts'), "import { x } from './missing';\nexport const y = x;\n", 'utf8');

    const lenient = await runCli([repo, '--json', '--quiet']);
    assert.equal(lenient.code, 0);
    const report = JSON.parse(lenient.stdout);
    assert.equal(report.stats.unresolved, 1);

    const strict = await runCli([repo, '--strict', '--json', '--quiet']);
    assert.equal(strict.code, 1);
  });
});
