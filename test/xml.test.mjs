import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkXml } from './helpers/xml.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('良构 XML 通过', () => {
  const res = checkXml('<a x="1"><b/><c>t</c></a>');
  assert.equal(res.ok, true);
});

test('未闭合标签被发现', () => {
  const res = checkXml('<a><b></a>');
  assert.equal(res.ok, false);
  assert.match(res.error, /未正确配对/);
});

test('尾部未闭合标签被发现', () => {
  const res = checkXml('<a><b></b>');
  assert.equal(res.ok, false);
  assert.match(res.error, /未闭合/);
});

test('裸 & 被发现', () => {
  const res = checkXml('<a>Fish & Chips</a>');
  assert.equal(res.ok, false);
  assert.match(res.error, /裸 &/);
});

test('转义后的实体通过', () => {
  const res = checkXml('<a>Fish &amp; Chips &#8212; ok &#x2014;</a>');
  assert.equal(res.ok, true);
});

test('未知实体被发现', () => {
  const res = checkXml('<a>&nbsp;</a>');
  assert.equal(res.ok, false);
  assert.match(res.error, /未知实体/);
});

test('属性缺引号被发现', () => {
  const res = checkXml('<a x=1></a>');
  assert.equal(res.ok, false);
  assert.match(res.error, /未加引号/);
});

test('属性值未转义的 & 被发现', () => {
  const res = checkXml('<a x="1 & 2"></a>');
  assert.equal(res.ok, false);
  assert.match(res.error, /裸 &|未知实体/);
});

test('注释与 VOID 元素被正确处理', () => {
  const res = checkXml('<a><!-- <b> --><br><img src="x"></a>');
  assert.equal(res.ok, true);
});

test('fixture 中的 HTML 样本通过校验', async () => {
  const text = await readFile(join(here, 'fixtures', 'xml-sample.html'), 'utf8');
  const res = checkXml(text);
  assert.equal(res.ok, true, res.ok ? '' : `${res.error} @${res.index}`);
});

test('CDATA 通过校验', () => {
  const res = checkXml('<a><![CDATA[ <not a tag> & raw ]]></a>');
  assert.equal(res.ok, true);
});
