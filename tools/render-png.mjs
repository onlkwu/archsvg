/**
 * 把 docs/architecture.svg 渲染成 docs/architecture.png。
 *
 * 为什么需要这一步：GitHub 的 Markdown 不会把 SVG 渲染进 <img>，
 * README 首图必须是位图。
 *
 * 不用 sharp/resvg 之类的依赖（本项目零依赖是硬约束），
 * 改为调用系统上已有的 Chromium 内核浏览器做无头截图。
 * 找不到浏览器时明确提示，而不是静默失败留下一个过期的 PNG。
 *
 * 用法: node tools/render-png.mjs [--width 600]
 */

import { execFile } from 'node:child_process';
import { access, constants, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const svgPath = join(root, 'docs', 'architecture.svg');
const pngPath = join(root, 'docs', 'architecture.png');

const widthArg = process.argv.indexOf('--width');
const labelWidth = widthArg !== -1 ? Number(process.argv[widthArg + 1]) : 600;

/** 各平台上 Chromium 内核浏览器的常见位置 */
const CANDIDATES = {
  win32: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ],
};

async function findBrowser() {
  const list = CANDIDATES[process.platform] ?? [];
  for (const p of list) {
    const ok = await access(p, constants.X_OK).then(() => true).catch(() => false);
    if (ok) return p;
  }
  return null;
}

const svgExists = await stat(svgPath).then(() => true).catch(() => false);
if (!svgExists) {
  console.error(`找不到 ${svgPath}，先跑: npm run svg`);
  process.exit(1);
}

const browser = await findBrowser();
if (!browser) {
  console.error('没有找到 Chromium 内核浏览器，无法生成 PNG。');
  console.error('可选做法：');
  console.error('  1) 安装 Chrome / Edge / Chromium 后重跑本脚本');
  console.error('  2) 手动把 docs/architecture.svg 在浏览器里打开并截图，另存为 docs/architecture.png');
  console.error('  3) 直接引用 SVG：把 README 里的图片路径换回 docs/architecture.svg（GitHub 上不会内联显示）');
  process.exit(1);
}

// SVG 有固定宽高，按它算窗口高度，避免截出大片留白
const header = await import('node:fs/promises').then((fs) => fs.readFile(svgPath, 'utf8'));
const dims = /<svg[^>]*width="([\d.]+)" height="([\d.]+)"/.exec(header);
const svgWidth = Number(dims?.[1] ?? 600);
const svgHeight = Number(dims?.[2] ?? 800);
const scale = labelWidth / svgWidth;
const windowWidth = Math.round(labelWidth);
const windowHeight = Math.round(svgHeight * scale);

const uri = `file:///${resolve(svgPath).replace(/\\/g, '/')}`;
const profile = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'archsvg-png-profile');

await rm(pngPath, { force: true });
await run(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--window-size=${windowWidth},${windowHeight}`,
    `--screenshot=${pngPath}`,
    uri,
  ],
  { encoding: 'utf8' },
).catch((err) => {
  // 有些浏览器版本即使成功也会以非 0 退出并往 stderr 写噪音，所以只看产物
  const noise = String(err.stderr ?? err.message ?? '');
  if (!/written to file/.test(noise)) {
    console.error(`渲染失败: ${noise.split('\n')[0]}`);
  }
});

const out = await stat(pngPath).then((s) => s).catch(() => null);
if (!out || out.size === 0) {
  console.error('渲染没有产出文件。');
  process.exit(1);
}
console.log(`已生成 ${pngPath}（${windowWidth}x${windowHeight}，${Math.round(out.size / 1024)} KB）`);
