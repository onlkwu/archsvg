#!/usr/bin/env node
/**
 * archsvg CLI。
 *
 * 退出码契约（会被 CI 依赖，不能乱改）：
 *   0  正常
 *   1  --check 发现架构违规，或 --strict 下存在无法解析的导入
 *   2  输入错误（路径不存在、参数非法、规则文件不合法）
 *
 * 默认把产物写到 stdout，只有给 --out 才落盘——
 * 这样 `archsvg . > arch.svg` 也能用，符合 Unix 直觉。
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Log } from '../src/log.mjs';
import { analyze } from '../src/analyze.mjs';
import { renderSvg } from '../src/render-svg.mjs';
import { renderHtml } from '../src/render-html.mjs';
import { buildReport, renderText } from '../src/report.mjs';
import { loadRules, checkRules } from '../src/rules.mjs';

const VERSION = '0.1.0';
const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_INPUT = 2;

const FLAGS = [
  { name: 'check', type: 'boolean', help: '执行架构规则检查，有违规时退出码 1' },
  { name: 'rules', type: 'string', value: '<file>', help: '规则文件路径（JSON）' },
  { name: 'out', type: 'string', value: '<file>', help: '写入文件而不是 stdout' },
  { name: 'format', type: 'string', value: '<fmt>', help: 'svg | html | json（默认 svg）' },
  { name: 'title', type: 'string', value: '<text>', help: '图标题，默认取目录名' },
  { name: 'group-dir', type: 'boolean', help: '按目录聚合，输出模块级视图' },
  { name: 'group-depth', type: 'number', value: '<n>', help: '聚合目录深度，默认 2' },
  { name: 'max-nodes', type: 'number', value: '<n>', help: '节点数上限，超出自动聚合，默认 400' },
  { name: 'max-files', type: 'number', value: '<n>', help: '扫描文件数上限，默认 5000' },
  { name: 'lang', type: 'string', value: '<list>', help: '只分析这些语言，逗号分隔：js,ts,py,generic' },
  { name: 'ignore', type: 'string', value: '<glob>', help: '额外忽略项，可重复' },
  { name: 'include-tests', type: 'boolean', help: '把测试文件也纳入图中' },
  { name: 'strict', type: 'boolean', help: '存在无法解析的导入时退出码非 0' },
  { name: 'json', type: 'boolean', help: '等价于 --format json' },
  { name: 'quiet', type: 'boolean', help: '不打印摘要与帮助性输出（警告仍会输出）' },
  { name: 'help', type: 'boolean', help: '显示帮助' },
  { name: 'version', type: 'boolean', help: '显示版本' },
];

/**
 * 短选项别名。
 *
 * `-o` 必须映射到真正带取值的选项上，而不是当成布尔开关：
 * 当成布尔时 `-o out.svg` 会把 out.svg 丢掉（flags.out = true，路径丢失），
 * 而且 stderr 里只有一句"未知参数"，用户完全不知道自己的输出路径去哪了。
 *
 * `-` 是"当前目录"的传统写法，作为位置参数处理。
 */
const SHORT_ALIASES = { '-h': 'help', '-v': 'version', '-o': 'out' };
const POSITIONAL_ALIASES = { '-': '.' };

/**
 * 可选的 --lang 值。
 * 必须与 src/lang.mjs 的 detectLanguage 返回值保持一致——
 * 这里写错会出现"参数通过校验但永远筛不出文件"的组合。
 */
const SUPPORTED_LANGUAGES = new Set(['js', 'ts', 'py', 'generic']);

/**
 * 只有作为可执行入口直接运行时才执行 main。
 *
 * 这样测试可以 import 这个模块来单独验证 parseArgs，
 * 而不会顺带把 CLI 跑一遍（那会往 stdout 打一整张 SVG）。
 */
const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`错误: ${err?.message || err}\n`);
    process.exit(EXIT_INPUT);
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  // 参数错误必须显式失败：静默忽略未知参数会让人以为检查跑过了
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) process.stderr.write(`参数错误: ${e}\n`);
    process.stderr.write(`运行 archsvg --help 查看用法\n`);
    process.exit(EXIT_INPUT);
  }

  if (parsed.flags.help) {
    process.stdout.write(usage());
    process.exit(EXIT_OK);
  }
  if (parsed.flags.version) {
    process.stdout.write(`archsvg ${VERSION}\n`);
    process.exit(EXIT_OK);
  }

  const target = parsed.positionals[0] || '.';
  const { flags } = parsed;

  // 上限类参数必须是正数。
  // 放负数过去会得到一个"看起来正常但其实是错的"结果：
  // --max-files -1 让扫描在第一个文件处就停下 ⇒ 空图；
  // --max-nodes -1 让每个仓库都被强制聚合 ⇒ 图变成几个方块。
  // 这两种都是静默的错误结果，比直接报错危险得多，所以在这里拦掉。
  for (const [name, label] of [['max-nodes', '节点数上限'], ['max-files', '文件数上限']]) {
    const v = flags[name];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < 1) {
      process.stderr.write(`错误: --${name}（${label}）需要 ≥ 1 的整数，收到 ${JSON.stringify(v)}\n`);
      process.exit(EXIT_INPUT);
    }
  }
  if (flags['group-depth'] !== undefined) {
    const v = flags['group-depth'];
    if (!Number.isInteger(v) || v < 1) {
      process.stderr.write(`错误: --group-depth 需要 ≥ 1 的整数，收到 ${JSON.stringify(v)}\n`);
      process.exit(EXIT_INPUT);
    }
  }

  const format = flags.json ? 'json' : String(flags.format || 'svg').toLowerCase();
  if (!['svg', 'html', 'json'].includes(format)) {
    process.stderr.write(`错误: 不支持的 --format "${format}"（可选 svg / html / json）\n`);
    process.exit(EXIT_INPUT);
  }

  const log = new Log();
  log.quiet = Boolean(flags.quiet);

  const languages = flags.lang
    ? String(flags.lang)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  // --lang 的白名单必须校验。
  // 不校验的后果很隐蔽：`--lang tss`（手滑多打一个 s）会筛出 0 个文件，
  // 于是产出一张空图、退出码 0——CI 里看到的是"成功"，图却是空的。
  if (languages) {
    const unknown = languages.filter((l) => !SUPPORTED_LANGUAGES.has(l));
    if (unknown.length > 0) {
      process.stderr.write(
        `错误: 不支持的 --lang ${unknown.map((u) => `"${u}"`).join(', ')}；` +
          `可选值: ${[...SUPPORTED_LANGUAGES].join(', ')}\n`,
      );
      process.exit(EXIT_INPUT);
    }
  }

  const result = await analyze(target, {
    log,
    languages,
    includeTests: Boolean(flags['include-tests']),
    groupDir: Boolean(flags['group-dir']),
    groupDepth: flags['group-depth'] ? Number(flags['group-depth']) : undefined,
    maxNodes: flags['max-nodes'] ? Number(flags['max-nodes']) : undefined,
    maxFiles: flags['max-files'] ? Number(flags['max-files']) : undefined,
    ignore: flags.ignore ? [].concat(flags.ignore) : undefined,
    strict: Boolean(flags.strict),
  });

  // 规则检查
  let violations = [];
  if (flags.check || flags.rules) {
    if (!flags.rules) {
      process.stderr.write('错误: --check 需要配合 --rules <file> 使用\n');
      process.exit(EXIT_INPUT);
    }
    let ruleset;
    try {
      ruleset = await loadRules(resolve(String(flags.rules)));
    } catch (err) {
      process.stderr.write(`错误: ${err.message}\n`);
      process.exit(EXIT_INPUT);
    }
    violations = checkRules({ files: result.files, resolved: result.resolved }, ruleset.rules);
  }

  const meta = await buildMeta(result, flags, format);
  const report = buildReport({
    root: result.root,
    graph: result.graph,
    layout: result.layout,
    violations,
    extras: result.extras,
  });

  let output;
  if (format === 'json') {
    output = `${JSON.stringify(report, null, 2)}\n`;
  } else {
    const rendered = renderSvg({ graph: result.graph, layout: result.layout, meta });
    output =
      format === 'html'
        ? renderHtml({ svg: rendered.svg, graph: result.graph, meta, width: rendered.width, height: rendered.height })
        : `${rendered.svg}\n`;
  }

  if (result.graph.stats.nodeCount === 0 && !flags.quiet) {
    process.stderr.write('提示: 没有发现可分析的源文件，图会是空的\n');
  }

  // 有诊断时给一句可行动的总结。
  // 只有逐条 warning 而没有总结，用户容易漏掉"为什么图长得不对"。
  if (!flags.quiet && result.diagnostics.length > 0) {
    const byCode = new Map();
    for (const d of result.diagnostics) byCode.set(d.code, (byCode.get(d.code) || 0) + 1);
    const parts = [...byCode.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code}×${n}`);
    process.stderr.write(`诊断 ${result.diagnostics.length} 条: ${parts.join(', ')}\n`);
    if (byCode.has('tsconfig-extends-package') || byCode.has('tsconfig-parse-failed')) {
      process.stderr.write('提示: 路径别名可能未生效，图上的"外部包"里可能混着仓内模块\n');
    }
  }

  // --check 的结论不是"闲聊"：它是这条命令存在的理由，也是 CI 里人唯一会看的行。
  // 所以它不受 --quiet 影响——把检查结论静默掉，等于让 --quiet 把工具的核心价值关掉。
  const wantSummary = Boolean(flags.check) || violations.length > 0 ? true : !flags.quiet;
  const summary = renderText(report, {
    expectCheck: Boolean(flags.check),
    durationMs: flags.check ? undefined : result.extras.durationMs,
  }).trim();

  if (flags.out !== undefined) {
    const outPath = resolve(String(flags.out));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, output, 'utf8');
    if (wantSummary) {
      process.stderr.write(
        `${summary}\n${flags.quiet ? '' : `已写入 ${outPath}\n`}`,
      );
    }
  } else {
    process.stdout.write(output);
    // JSON 走 stdout，摘要绝不能混进去污染它
    if (wantSummary && format !== 'json') {
      process.stderr.write(`${summary}\n`);
    }
    // JSON 模式下仍然要把检查结论说出去，否则 CI 日志里什么都没有
    if (wantSummary && format === 'json' && Boolean(flags.check)) {
      process.stderr.write(`${summary}\n`);
    }
  }

  if (violations.length > 0) process.exit(EXIT_VIOLATION);
  if (flags.strict && result.extras.unresolved > 0) {
    if (!flags.quiet) {
      process.stderr.write(`严格模式: 有 ${result.extras.unresolved} 个导入无法解析\n`);
    }
    process.exit(EXIT_VIOLATION);
  }
  process.exit(EXIT_OK);
}

/**
 * 读取 package.json 作为标题与副标题来源。
 * 刻意不读 git：这个工具必须能在没有 git 的目录里工作。
 */
async function buildMeta(result, flags, format) {
  let pkg = null;
  try {
    pkg = JSON.parse(await readFile(join(result.root, 'package.json'), 'utf8'));
  } catch {
    pkg = null;
  }

  const title = flags.title || pkg?.name || basename(result.root) || 'repository';
  const version = pkg?.version ? ` v${pkg.version}` : '';
  const s = result.graph.stats;

  const subtitle = [
    `${s.nodeCount} 个模块`,
    `${s.edgeCount} 条依赖`,
    `${s.totalLines} 行代码`,
    s.externalCount > 0 ? `${s.externalCount} 个外部包` : null,
    s.cycleCount > 0 ? `${s.cycleCount} 组循环依赖` : null,
    s.grouped ? `按目录聚合（深度 ${s.groupDepth}）` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    title: `${title}${version}`,
    subtitle,
    footnote: format === 'svg' ? 'archsvg' : undefined,
    groupLabel: s.grouped ? '模块（按目录聚合）' : '文件',
  };
}

/**
 * 参数解析。
 *
 * 手写而不是引 commander：flags 是固定的十几个，
 * 而且 --ignore 需要支持重复出现，"能重复"这个语义用现成库反而更绕。
 */
export function parseArgs(argv, flags = FLAGS) {
  const spec = new Map();
  for (const f of flags) spec.set(f.name, f);

  const out = { flags: {}, positionals: [], errors: [] };
  let i = 0;

  while (i < argv.length) {
    const token = argv[i];

    // 裸 `--`：后面全部当位置参数
    if (token === '--') {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? null : body.slice(eq + 1);
      const def = spec.get(name);

      if (!def) {
        out.errors.push(`未知参数 --${name}`);
        i += 1;
        continue;
      }

      if (def.type === 'boolean') {
        if (inlineValue !== null) out.errors.push(`--${name} 是布尔参数，不接受取值`);
        out.flags[name] = true;
        i += 1;
        continue;
      }

      let value = inlineValue;
      let consumed = 1; // 本参数自身占用的 token 数
      if (value === null) {
        let next = argv[i + 1];
        // `--` 是标准的"选项结束"标记：紧跟其后的东西即使以横杠开头
        // 也要当取值，否则就没法把名字以横杠开头的路径传给 --out。
        let skippedSeparator = false;
        if (next === '--') {
          skippedSeparator = true;
          next = argv[i + 2];
        }
        if (next === undefined || (!skippedSeparator && next.startsWith('--') && next.length > 2)) {
          out.errors.push(`--${name} 缺少取值`);
          i += 1;
          continue;
        }
        value = next;
        consumed = skippedSeparator ? 3 : 2;
      }

      // 显式给了空值（`--out=`）必须报错。
      // 放过去的话 flags.out 是空字符串，后面的 `if (flags.out)` 判假，
      // 于是产物被静默写到 stdout——CI 里这意味着"以为写了文件，其实什么也没写"。
      if (value === '') {
        out.errors.push(`--${name} 的取值不能为空`);
        i += consumed;
        continue;
      }

      const parsed = def.type === 'number' ? Number(value) : value;
      if (def.type === 'number' && !Number.isFinite(parsed)) {
        out.errors.push(`--${name} 需要数字，收到 "${value}"`);
      } else if (name === 'ignore') {
        out.flags.ignore = [].concat(out.flags.ignore || [], parsed);
      } else {
        out.flags[name] = parsed;
      }
      i += consumed;
      continue;
    }

    if (token.startsWith('-') && token.length > 0 && token !== '--') {
      if (token in POSITIONAL_ALIASES) {
        out.positionals.push(POSITIONAL_ALIASES[token]);
        i += 1;
        continue;
      }
      const longName = SHORT_ALIASES[token];
      if (longName) {
        const def = spec.get(longName);
        // 带取值的短选项要像它的长形式一样吃掉下一个 token
        if (def && def.type !== 'boolean') {
          const next = argv[i + 1];
          if (next === undefined || (next.startsWith('--') && next.length > 2)) {
            out.errors.push(`${token}（--${longName}）缺少取值`);
            i += 1;
            continue;
          }
          if (next === '') {
            out.errors.push(`${token}（--${longName}）的取值不能为空`);
            i += 1;
            continue;
          }
          if (longName === 'ignore') {
            out.flags.ignore = [].concat(out.flags.ignore || [], next);
          } else {
            out.flags[longName] = next;
          }
          i += 2;
          continue;
        }
        out.flags[longName] = true;
        i += 1;
        continue;
      }
      out.errors.push(`未知参数 ${token}`);
      i += 1;
      continue;
    }

    out.positionals.push(token);
    i += 1;
  }

  return out;
}

function usage() {
  const lines = [
    `archsvg ${VERSION} — 从仓库结构生成可嵌入 README 的架构图`,
    '',
    '用法:',
    '  archsvg <repo> [选项]',
    '  archsvg <repo> --check --rules rules.json',
    '',
    '选项:',
  ];
  for (const f of FLAGS) {
    const arg = f.type === 'boolean' ? '' : ` ${f.value || '<value>'}`;
    lines.push(`  --${f.name}${arg}`.padEnd(30) + f.help);
  }
  lines.push('', '示例:');
  lines.push('  archsvg . --out docs/architecture.svg');
  lines.push('  archsvg . --format html --out arch.html');
  lines.push('  archsvg . --group-dir --max-nodes 60 --out arch.svg');
  lines.push('  archsvg . --check --rules rules.example.json');
  return `${lines.join('\n')}\n`;
}
