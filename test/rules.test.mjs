import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileGlob,
  matchesGlob,
  validateRules,
  checkRules,
  loadRules,
  RULES_SCHEMA_VERSION,
} from '../src/rules.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';

const goodRules = {
  schemaVersion: RULES_SCHEMA_VERSION,
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

test('glob：** 能匹配零层目录', () => {
  const re = compileGlob('src/ui/**');
  assert.equal(matchesGlob('src/ui/page.ts', re), true);
  assert.equal(matchesGlob('src/ui/nested/deep/page.ts', re), true);
  assert.equal(matchesGlob('src/api/server.ts', re), false);
});

test('glob：目录型 pattern 匹配其下所有内容', () => {
  const re = compileGlob('src/db');
  assert.equal(matchesGlob('src/db/client.ts', re), true);
  assert.equal(matchesGlob('src/db', re), true);
  assert.equal(matchesGlob('src/dbx/client.ts', re), false);
});

test('glob：* 不跨目录，? 匹配单字符', () => {
  const star = compileGlob('src/*.ts');
  assert.equal(matchesGlob('src/main.ts', star), true);
  assert.equal(matchesGlob('src/api/main.ts', star), false);

  const q = compileGlob('src/mai?.ts');
  assert.equal(matchesGlob('src/main.ts', q), true);
  assert.equal(matchesGlob('src/mai.ts', q), false);
});

test('glob：前导 ./ 与重复 ./ 被归一化（编辑器复制路径的常见形式）', () => {
  const canonical = compileGlob('src/ui/**');
  for (const raw of ['./src/ui/**', '././src/ui/**', './././src/ui/**', 'src\\ui\\**', 'src/ui/']) {
    const re = compileGlob(raw);
    for (const p of ['src/ui/page.ts', 'src/ui/nested/deep/x.ts', 'src/ui']) {
      assert.equal(
        matchesGlob(p, re),
        matchesGlob(p, canonical),
        `pattern ${raw} 对 ${p} 的判定与规范写法不一致`,
      );
    }
    assert.equal(matchesGlob('src/api/a.ts', re), false, `${raw} 不该命中 src/api`);
  }
});

test('glob：点号等正则元字符被当字面量', () => {
  const re = compileGlob('a/b.test.ts');
  assert.equal(matchesGlob('a/b.test.ts', re), true);
  assert.equal(matchesGlob('a/bXtest.ts', re), false);
});

test('validateRules：合法规则通过并规范化', () => {
  const out = validateRules(goodRules, 'inline');
  assert.equal(out.rules.length, 1);
  assert.equal(out.rules[0].forbidden, true);
});

test('validateRules：schemaVersion 不对要报错', () => {
  assert.throws(
    () => validateRules({ schemaVersion: 99, rules: [] }),
    /schemaVersion 必须是 1/,
  );
});

test('validateRules：缺字段要报错', () => {
  assert.throws(
    () => validateRules({ schemaVersion: 1, rules: [{ id: 'x', from: 'a', to: 'b' }] }),
    /message 必须是非空字符串/,
  );
});

test('validateRules：forbidden 必须显式写 true', () => {
  assert.throws(
    () =>
      validateRules({
        schemaVersion: 1,
        rules: [{ id: 'x', from: 'a', to: 'b', message: 'm', forbidden: false }],
      }),
    /forbidden 必须显式写 true/,
  );
});

test('validateRules：重复 id 要报错', () => {
  assert.throws(
    () =>
      validateRules({
        schemaVersion: 1,
        rules: [
          { id: 'dup', from: 'a', to: 'b', message: 'm', forbidden: true },
          { id: 'dup', from: 'c', to: 'd', message: 'm', forbidden: true },
        ],
      }),
    /id 重复/,
  );
});

test('checkRules：抓到 ui → db 违规并给出行号', async () => {
  const r = await analyzeFixture('ts-app');
  const violations = checkRules(r, goodRules.rules);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, 'src/ui/page.ts');
  assert.equal(violations[0].ruleId, 'ui-not-db');
  assert.deepEqual(violations[0].refs, [{ file: 'src/ui/page.ts', line: 2 }]);
});

test('checkRules：干净仓库没有违规', async () => {
  const r = await analyzeFixture('clean-app');
  assert.deepEqual(checkRules(r, goodRules.rules), []);
});

test('checkRules：不匹配任何文件的规则静默通过', async () => {
  const r = await analyzeFixture('ts-app');
  const rules = [
    { id: 'nope', from: 'src/nothing/**', to: 'src/db/**', forbidden: true, message: 'm' },
  ];
  assert.deepEqual(checkRules(r, rules), []);
});

test('checkRules：违规按文件与规则排序，结果稳定', async () => {
  const r = await analyzeFixture('ts-app');
  const rules = [
    ...goodRules.rules,
    { id: 'a-any-to-db', from: 'src/**', to: 'src/db/**', forbidden: true, message: '都别碰 db' },
  ];
  const a = checkRules(r, rules).map((v) => `${v.ruleId}|${v.from}`);
  const b = checkRules(r, rules).map((v) => `${v.ruleId}|${v.from}`);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3); // ui-not-db + api→db + ui→db
});

test('loadRules：文件不存在时给出可读错误', async () => {
  await assert.rejects(() => loadRules(join(tmpdir(), 'definitely-not-here.json')), (err) => {
    assert.equal(err.code, 'RULES_READ_FAILED');
    return true;
  });
});

test('loadRules：非法 JSON 给出可读错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archsvg-'));
  try {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ not json', 'utf8');
    await assert.rejects(() => loadRules(file), (err) => {
      assert.equal(err.code, 'RULES_PARSE_FAILED');
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadRules：真实读盘路径可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archsvg-'));
  try {
    const file = join(dir, 'rules.json');
    await writeFile(file, JSON.stringify(goodRules), 'utf8');
    const loaded = await loadRules(file);
    assert.equal(loaded.rules.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
