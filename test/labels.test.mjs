import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLabels, shortestUniqueSuffix } from '../src/labels.mjs';
import { analyzeFixture } from './helpers/fixtures.mjs';

test('不重名时直接返回文件名', () => {
  const labels = computeLabels(['src/a.ts', 'src/b.ts']);
  assert.equal(labels.get('src/a.ts'), 'a.ts');
  assert.equal(labels.get('src/b.ts'), 'b.ts');
});

test('重名时补上最短的目录前缀', () => {
  const labels = computeLabels([
    'src/ui/index.ts',
    'src/db/index.ts',
    'src/api/index.ts',
    'src/unique.ts',
  ]);
  assert.equal(labels.get('src/ui/index.ts'), 'ui/index.ts');
  assert.equal(labels.get('src/db/index.ts'), 'db/index.ts');
  assert.equal(labels.get('src/api/index.ts'), 'api/index.ts');
  // 不重名的文件不该被拉着一起变长
  assert.equal(labels.get('src/unique.ts'), 'unique.ts');
});

test('一层前缀不够时继续往前补', () => {
  const labels = computeLabels([
    'src/a/index.ts',
    'src/b/index.ts',
    'lib/x/index.ts',
    'lib/y/index.ts',
  ]);
  // a/index.ts 与 b/index.ts 已经能区分，不必带 src
  assert.equal(labels.get('src/a/index.ts'), 'a/index.ts');
  assert.equal(labels.get('lib/x/index.ts'), 'x/index.ts');
});

test('中间层同名时也要能区分', () => {
  const labels = computeLabels([
    'packages/a/src/index.ts',
    'packages/b/src/index.ts',
  ]);
  // src/index.ts 两者相同，必须继续往前补到 packages 层
  assert.equal(labels.get('packages/a/src/index.ts'), 'a/src/index.ts');
  assert.equal(labels.get('packages/b/src/index.ts'), 'b/src/index.ts');
});

test('所有路径都一样时退回完整路径（不抛错）', () => {
  assert.equal(shortestUniqueSuffix('a/b/c.ts', new Set(['a/b/c.ts'])), 'a/b/c.ts');
});

test('空输入不报错', () => {
  assert.equal(computeLabels([]).size, 0);
  assert.equal(shortestUniqueSuffix('a.ts', new Set()), 'a.ts');
});

test('任一仓库里都不应出现两个相同的显示名', async () => {
  for (const name of ['ts-app', 'py-app', 'demo-app', 'clean-app']) {
    const fixture = name === 'demo-app' ? '../../demo' : name;
    const r = await analyzeFixture(fixture);
    const seen = new Map();
    for (const n of r.graph.nodes) {
      if (n.external) continue;
      seen.set(n.label, (seen.get(n.label) || 0) + 1);
    }
    const dup = [...seen].filter(([, c]) => c > 1);
    assert.deepEqual(dup, [], `${name}: 显示名重复 ${JSON.stringify(dup)}`);
  }
});

test('目录聚合模式下标签是目录名，不被文件名逻辑影响', async () => {
  const r = await analyzeFixture('ts-app', { groupDir: true, groupDepth: 2 });
  const labels = r.graph.nodes.filter((n) => !n.external).map((n) => n.label).sort();
  assert.deepEqual(labels, ['src', 'src/api', 'src/db', 'src/ui', 'src/utils']);
});
