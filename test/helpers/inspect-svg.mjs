/**
 * 生成 SVG 的自检：所有几何元素是否落在画布内。
 *
 * 放在仓库里而不是临时脚本，因为"图画到画布外"是回归高发区——
 * 环内边、自环、同层走线都曾经越界。
 *
 * 必须按真实嵌套深度累积 translate：图例包在 <g transform> 里，
 * 用"正则切割 + 非贪婪匹配"会把嵌套组错配，把图例误判成越界。
 */
import { readFile } from 'node:fs/promises';

const file = process.argv[2] || 'out/demo.svg';
const svg = await readFile(file, 'utf8');

const header = /<svg[^>]*width="([\d.]+)" height="([\d.]+)"/.exec(svg);
if (!header) {
  console.error('无法解析 SVG 尺寸');
  process.exit(2);
}
const width = Number(header[1]);
const height = Number(header[2]);

/** 逐 token 扫描，维护 translate 栈 */
const stack = [{ dx: 0, dy: 0 }];
const points = [];
const tokens = /<g\b([^>]*)>|<\/g>|<path\b[^>]*\bd="([^"]+)"[^>]*>/g;

let m;
while ((m = tokens.exec(svg)) !== null) {
  if (m[0].startsWith('</g>')) {
    if (stack.length > 1) stack.pop();
    continue;
  }
  if (m[0].startsWith('<g')) {
    const attrs = m[1] || '';
    const t = /transform="translate\((-?[\d.]+),\s*(-?[\d.]+)\)"/.exec(attrs);
    const top = stack[stack.length - 1];
    stack.push(
      t ? { dx: top.dx + Number(t[1]), dy: top.dy + Number(t[2]) } : { dx: top.dx, dy: top.dy },
    );
    continue;
  }
  // path
  const cur = stack[stack.length - 1];
  for (const seg of m[2].matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
    points.push({ x: Number(seg[1]) + cur.dx, y: Number(seg[2]) + cur.dy });
  }
}

const bad = points.filter((p) => p.x < -0.5 || p.y < -0.5 || p.x > width + 0.5 || p.y > height + 0.5);

console.log(`画布: ${width} x ${height}`);
console.log(`几何点: ${points.length}`);
console.log(`节点数: ${(svg.match(/rx="6"/g) || []).length}`);
console.log(`边路径数: ${(svg.match(/marker-end=/g) || []).length}`);
console.log(`循环色出现次数: ${(svg.match(/c0392b/gi) || []).length}`);

if (bad.length > 0) {
  console.log(`越界点: ${bad.length}`);
  for (const p of bad.slice(0, 8)) console.log(`  (${p.x}, ${p.y})`);
  console.log('FAIL: 存在越界坐标');
  process.exit(1);
}
console.log('OK: 所有几何都在画布内');
