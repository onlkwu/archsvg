/**
 * 文本宽度估算。
 *
 * 单独成模块是为了让布局层和渲染层用同一套估算——
 * 布局按 60 算宽、渲染按 80 算宽，就会出现文字溢出节点的情况。
 */

/**
 * 按显示宽度估算字符数：中文一个字占两个等宽位。
 *
 * 不区分全角半角会直接毁掉图例和节点宽度，"循环依赖"被当成 4 个半角字符，
 * 于是整行文字溢出到别的元素上。
 *
 * @param {string} text
 * @returns {number} 以半角字符为单位的宽度
 */
export function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * 等宽字体下的像素宽度估算。
 * @param {string} text
 * @param {number} fontSize
 */
export function textWidth(text, fontSize) {
  return displayWidth(text) * fontSize * 0.6;
}
