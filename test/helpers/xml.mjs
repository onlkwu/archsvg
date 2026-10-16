/**
 * 极小的 XML 良构性校验器。
 *
 * 为什么自己写：为了一个断言引入 XML 解析依赖，会破坏"零依赖"这个前提；
 * 而 SVG 最常见的故障（标签没闭合、属性没引号、& 没转义）用几十行就能全部覆盖。
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const NAMED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/**
 * @param {string} text
 * @returns {{ ok: true } | { ok: false, error: string, index: number }}
 */
export function checkXml(text) {
  const stack = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      const err = checkText(text.slice(i), i);
      return err ?? { ok: true };
    }

    const textErr = checkText(text.slice(i, lt), i);
    if (textErr) return textErr;

    // 注释
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return fail('注释未闭合', lt);
      if (text.slice(lt + 4, end).includes('--')) return fail('注释内容不能包含 --', lt);
      i = end + 3;
      continue;
    }

    // CDATA / DOCTYPE / XML 声明 / 处理指令
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) return fail('CDATA 未闭合', lt);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      if (end === -1) return fail('声明未闭合', lt);
      i = end + 1;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt);
      if (end === -1) return fail('处理指令未闭合', lt);
      i = end + 2;
      continue;
    }

    // 结束标签
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end === -1) return fail('结束标签未闭合', lt);
      const name = text.slice(lt + 2, end).trim();
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) return fail(`非法结束标签名 "${name}"`, lt);
      const top = stack.pop();
      if (!top) return fail(`多余的结束标签 </${name}>`, lt);
      if (top.name !== name) return fail(`标签未正确配对：<${top.name}> 被 </${name}> 关闭`, lt);
      i = end + 1;
      continue;
    }

    // 开始标签
    const tag = readStartTag(text, lt);
    if (tag.error) return fail(tag.error, lt);
    if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name)) {
      stack.push({ name: tag.name, index: lt });
    }
    i = tag.end;
  }

  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return fail(`标签 <${top.name}> 未闭合`, top.index);
  }
  return { ok: true };

  function fail(error, index) {
    return { ok: false, error, index };
  }
}

function checkText(text, offset) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '&') continue;
    const semi = text.indexOf(';', i);
    if (semi === -1) return { ok: false, error: '裸 & 未转义', index: offset + i };
    const entity = text.slice(i + 1, semi);
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      if (!/^[0-9a-fA-F]+$/.test(entity.slice(2))) {
        return { ok: false, error: `非法字符引用 &${entity};`, index: offset + i };
      }
    } else if (entity.startsWith('#')) {
      if (!/^[0-9]+$/.test(entity.slice(1))) {
        return { ok: false, error: `非法字符引用 &${entity};`, index: offset + i };
      }
    } else if (!NAMED_ENTITIES.has(entity)) {
      return { ok: false, error: `未知实体 &${entity};`, index: offset + i };
    }
    i = semi;
  }
  if (text.includes('<')) return { ok: false, error: '内容中出现裸 <', index: offset };
  return null;
}

function readStartTag(text, lt) {
  let i = lt + 1;
  const nameMatch = /^[A-Za-z_][\w.:-]*/.exec(text.slice(i));
  if (!nameMatch) return { error: '开始标签名非法' };
  const name = nameMatch[0];
  i += name.length;

  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) return { error: `标签 <${name}> 未闭合` };

    if (text.startsWith('/>', i)) return { name, selfClosing: true, end: i + 2 };
    if (text[i] === '>') return { name, selfClosing: false, end: i + 1 };

    const attr = /^[A-Za-z_][\w.:-]*/.exec(text.slice(i));
    if (!attr) return { error: `标签 <${name}> 的属性名非法（偏移 ${i}）` };
    i += attr[0].length;

    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== '=') return { error: `属性 ${attr[0]} 缺少 =` };
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const quote = text[i];
    if (quote !== '"' && quote !== "'") return { error: `属性 ${attr[0]} 的值未加引号` };
    const close = text.indexOf(quote, i + 1);
    if (close === -1) return { error: `属性 ${attr[0]} 的引号未闭合` };

    const value = text.slice(i + 1, close);
    if (value.includes('<')) return { error: `属性 ${attr[0]} 的值中出现裸 <` };
    const attrErr = checkText(value, 0);
    if (attrErr) return { error: `属性 ${attr[0]}：${attrErr.error}` };
    i = close + 1;
  }
}
