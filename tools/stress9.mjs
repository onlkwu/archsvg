/**
 * 鲁棒性套件 9：文档卫生 —— 全仓库范围内查找"任务视角"内容。
 *
 * 面向读者的文档里不应该出现仓库建立、推送、发布阶段的操作记录：
 * 它们对读者是噪音，而且往往在事实变化后变成错的（把占位用户名换掉之后，
 * "发布前要记得改它"这类提示就失效了）。这个套件把判据固化下来。
 *
 * 判据要区分两类文字：
 *   - 设计理由（"为什么不用力导向"）：对未来的维护者有用，保留
 *   - 任务痕迹（"按计划""首次推送""当前分支"）：只对某一次会话有意义，应删
 *
 * 用法: node tools/stress9.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'out']);
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.ts', '.py', '.html', '.svg', '.gitignore', '.gitattributes']);

async function collect(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await collect(p, out);
    else out.push(p);
  }
  return out;
}

const files = await collect(root);
const isChecker = (f) => f.endsWith(`stress9.mjs`) || f.endsWith(`stress9${'.mjs'}`);
const docFiles = files.filter((f) => /\.(md|json)$/.test(f) && !f.includes('fixtures'));
const codeFiles = files.filter((f) => /\.(mjs|js|ts|py)$/.test(f));
const allTextFiles = files.filter(
  (f) => (TEXT_EXT.has(extname(f)) || /\.git(ignore|attributes)$/.test(f)) && !isChecker(f),
);

/**
 * 判断某一行是不是"检查器自己的模式定义或说明"。
 *
 * 扫描类脚本必然要在源码里写出它要禁止的字符串（正则、标签、示例），
 * 如果不过滤掉这些行，检查器会持续报告自己——这类假阳性会让人
 * 逐渐忽略整个套件的输出，比不检查更糟。
 */
function isSelfReference(line) {
  return (
    /^\s*(\/\/|\*|\/\*)/.test(line) ||          // 注释
    /\[\/.*\/[a-z]*,/.test(line) ||              // 模式数组项 /re/, 'label'
    /'[^']*(?:TODO|FIXME|计划|待补)[^']*'/.test(line) ||
    /`[^`]*(?:TODO|FIXME|计划|待补)[^`]*`/.test(line)
  );
}

// ---------------------------------------------------------------------------
// 1) 面向用户的文档里不应出现仓库建立阶段的操作
// ---------------------------------------------------------------------------
{
  const patterns = [
    [/git\s+remote\s+add/i, 'git remote add（建仓操作）'],
    [/git\s+push/i, 'git push（推送操作）'],
    [/git\s+pull/i, 'git pull（同步操作）'],
    [/首次推送|首次提交|initial push/i, '首次推送说明'],
    [/发布前要改|publish 前|before publishing/i, '发布前清单'],
    [/占位用户|placeholder user|OWNER\/|github\.com\/OWNER/i, '占位用户名'],
    [/当前分支|current branch/i, '当前分支'],
    [/克隆下来的人|if you cloned/i, '针对克隆者的临时说明'],
  ];
  const hits = [];
  for (const file of docFiles) {
    const text = await readFile(file, 'utf8');
    for (const [re, label] of patterns) {
      if (re.test(text)) hits.push(`${relative(root, file)}: ${label}`);
    }
  }
  check('面向用户的文档里没有建仓/推送类内容', hits.length === 0, hits.join(', '));
}

// ---------------------------------------------------------------------------
// 2) 全部文本文件里不应出现"任务/计划"口吻的痕迹
// ---------------------------------------------------------------------------
{
  const patterns = [
    [/按照?计划|按批准的?计划|per the plan|as planned/i, '引用计划'],
    [/用户(?:要求|让我|指定)|the user asked me/i, '引用用户指令'],
    [/我(?:在)?(?:这轮|本次|这次)(?:改|修|加|做)/, '以会话为单位叙述改动'],
    [/接下来(?:要|将)|下一步(?:要|将)/, '待办口吻'],
    [/\bTODO\b|\bFIXME\b|\bHACK:/, 'TODO 标记'],
    [/待补|待定|暂未实现|not yet implemented/i, '未完成标记'],
    [/让我(?:先|来)|我先(?:看|查|跑)/, '第一人称操作叙述'],
  ];
  const hits = [];
  for (const file of allTextFiles) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    for (const [re, label] of patterns) {
      lines.forEach((line, i) => {
        if (!re.test(line)) return;
        if (isSelfReference(line)) return;
        hits.push(`${relative(root, file)}:${i + 1} ${label}`);
      });
    }
  }
  check('没有任务/计划口吻的残留', hits.length === 0, hits.slice(0, 6).join(' | '));
}

// ---------------------------------------------------------------------------
// 3) 不应有绝对路径或本机专属信息
// ---------------------------------------------------------------------------
{
  // 只匹配"完整的本机绝对路径"，不匹配临时目录名的前缀——
  // 后者是实现细节（测试要在系统临时目录里造仓库），不是把本机路径写死。
  const patterns = [
    [/[A-Za-z]:\\{1,2}(?:Users|bot|dsh)(?:\\|\/)/, 'Windows 绝对路径'],
    [/\/(?:Users|home)\/[A-Za-z0-9._-]+\//, 'POSIX 家目录绝对路径'],
    [/\bD:[\\/]bot\b/, '本机工作区路径'],
    [/\bC:[\\/]Users[\\/][A-Za-z0-9._-]+/, '本机用户目录'],
  ];
  const hits = [];
  for (const file of allTextFiles) {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    for (const [re, label] of patterns) {
      lines.forEach((line, i) => {
        const m = re.exec(line);
        if (!m) return;
        if (isSelfReference(line)) return;
        hits.push(`${relative(root, file)}:${i + 1} ${label} → ${m[0].slice(0, 40)}`);
      });
    }
  }
  check('没有硬编码的绝对路径', hits.length === 0, hits.slice(0, 5).join(' | '));
}

// ---------------------------------------------------------------------------
// 4) 文档里提到的命令必须真的存在（脚本名、文件路径）
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const scriptNames = new Set(Object.keys(pkg.scripts ?? {}));

  const mentioned = new Set();
  for (const file of docFiles) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/npm run ([\w:-]+)/g)) mentioned.add(m[1]);
  }
  const missing = [...mentioned].filter((s) => !scriptNames.has(s));
  check('文档里引用的 npm script 都存在', missing.length === 0,
    missing.length ? `缺失: ${missing.join(', ')}（已有: ${[...scriptNames].join(', ')}）` : '');

  // 文档里提到的仓库内文件路径必须存在
  const badPaths = [];
  for (const file of docFiles) {
    const text = await readFile(file, 'utf8');
    // 反引号里的相对路径，且带扩展名、不以 http/命令开头
    for (const m of text.matchAll(/`([\w./-]+\.(?:mjs|md|json|svg|png|ts|py))`/g)) {
      const p = m[1];
      if (p.includes('..') || p.startsWith('/') || /\s/.test(p)) continue;
      // 形如 bin/cli.mjs、docs/architecture.svg 这种仓库内路径
      if (!p.includes('/')) continue;
      const exists = await readFile(join(root, p), 'utf8').then(() => true).catch(() => false);
      if (!exists) badPaths.push(`${relative(root, file)} → ${p}`);
    }
  }
  check('文档里提到的仓库内文件都存在', badPaths.length === 0, badPaths.slice(0, 5).join(', '));
}

// ---------------------------------------------------------------------------
// 5) 产品代码与工具脚本都应有文件级注释
// ---------------------------------------------------------------------------
{
  // 只要求仓库根的 src / bin / tools。
  //   - test/*.test.mjs 靠描述性测试名表达意图，逐文件加 docstring 是形式主义
  //   - demo/ 是刻意做坏的演示 fixture，保持"普通源代码"的样子才有价值
  //   - test/fixtures/ 同理，而且它们内部也有名为 src 的目录，必须按仓库根路径判断
  const targets = codeFiles.filter((f) => {
    const rel = relative(root, f).replace(/\\/g, '/');
    if (rel.startsWith('demo/') || rel.startsWith('test/')) return false;
    return /^(src|bin|tools)\//.test(rel) && !rel.endsWith('stress9.mjs');
  });
  const missing = [];
  for (const file of targets) {
    const text = await readFile(file, 'utf8');
    const head = text.slice(0, 800);
    const hasFileComment = /^\s*\/\*\*/.test(head) || /^#![^\n]*\n\s*\/\*\*/.test(head);
    if (!hasFileComment) missing.push(relative(root, file));
  }
  check(
    `src / bin / tools 的每个文件都有文件级注释（共 ${targets.length} 个）`,
    missing.length === 0,
    missing.join(', '),
  );
}

// ---------------------------------------------------------------------------
// 6) 提交信息里不应出现工具署名或协作痕迹
// ---------------------------------------------------------------------------
{
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('git', ['log', '--format=%B%n---AUTHOR---%an <%ae>'], {
    cwd: root,
    encoding: 'utf8',
  }).catch(() => ({ stdout: '' }));

  check('提交信息里没有工具署名',
    !/Co-Authored-By:\s*(?:Claude|DeepSeek|GPT|Copilot)/i.test(stdout),
    (/Co-Authored-By:[^\n]*/.exec(stdout) ?? [''])[0]);
  check('提交信息里没有 "Generated with" 之类痕迹',
    !/Generated with|generated by (?:an )?AI/i.test(stdout));

  // 提交只应有一个（干净历史），且署名是真人配置而非占位
  const count = (await run('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();
  check('历史是单个提交', count === '1', `${count} 个提交`);
  check('提交署名不是占位值',
    !/example\.com|archsvg <archsvg@/.test(stdout), (/---AUTHOR---(.+)/.exec(stdout) ?? ['', ''])[1]);
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
  process.exit(1);
}
