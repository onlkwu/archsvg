import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseImports, stripPythonDocstrings, stripBlockComments } from '../src/imports.mjs';

test('JS：静态导入、re-export、动态导入、require 都能识别', () => {
  const src = [
    "import { a } from './a';",
    "import b from '../b.js';",
    "import './side-effect.css';",
    "import type { T } from '@types/t';",
    "export * from './star';",
    "export { x } from './named';",
    "const c = await import('./dyn');",
    "const d = require('./req');",
    "import e, { f as g } from 'pkg';",
  ].join('\n');

  const refs = parseImports('src/x.ts', 'ts', src);
  const specs = refs.map((r) => r.specifier);
  assert.deepEqual(specs, [
    './a',
    '../b.js',
    './side-effect.css',
    '@types/t',
    './star',
    './named',
    './dyn',
    './req',
    'pkg',
  ]);
  const kinds = Object.fromEntries(refs.map((r) => [r.specifier, r.kind]));
  assert.equal(kinds['./star'], 're-export');
  assert.equal(kinds['./dyn'], 'dynamic');
  assert.equal(kinds['./req'], 'require');
});

test('JS：行号准确', () => {
  const src = '// 注释\n\nimport { a } from "./a";\n';
  const refs = parseImports('x.ts', 'ts', src);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].line, 3);
});

test('JS：多行 import 语句也能识别', () => {
  const src = ['import {', '  a,', '  b,', "} from './multi';"].join('\n');
  const refs = parseImports('x.ts', 'ts', src);
  assert.deepEqual(refs.map((r) => r.specifier), ['./multi']);
  assert.equal(refs[0].line, 1);
});

test('Python：from/import/相对导入都能识别', () => {
  const src = [
    'from .api.routes import build_routes',
    'from ..pkg import x, y',
    'from . import helpers',
    'import os',
    'import json, sys',
    'import a.b.c as abc',
  ].join('\n');

  const refs = parseImports('app/mod.py', 'py', src);
  const specs = refs.map((r) => r.specifier);
  // from pkg import name 会同时产出 pkg 与 pkg.name：
  // name 可能是子模块也可能是普通变量，只有解析层拿着文件索引才能判。
  assert.deepEqual(specs, [
    '.api.routes',
    '.api.routes.build_routes',
    '..pkg',
    '..pkg.x',
    '..pkg.y',
    '.',
    '.helpers',
    'os',
    'json',
    'sys',
    'a.b.c',
  ]);
});

test('Python：括号形式的 import 也能识别，且行号不偏移', () => {
  const src = [
    'from .api import (',
    '    routes,',
    '    helpers,',
    ')',
    'import os',
  ].join('\n');

  const refs = parseImports('app/__init__.py', 'py', src);
  assert.deepEqual(refs.map((r) => r.specifier), ['.api', '.api.helpers', '.api.routes', 'os']);
  assert.deepEqual(refs.map((r) => r.line), [1, 1, 1, 5]);
});

test('Python：docstring 里的 import 不会产生假边', () => {
  const src = [
    '"""模块说明。',
    '',
    '    from app.auth import login',
    '    import legacy_thing',
    '"""',
    '',
    'from .core import real',
  ].join('\n');

  const refs = parseImports('app/__init__.py', 'py', src);
  // 只有 app.core 相关候选，docstring 里的 app.auth / legacy_thing 必须消失
  assert.deepEqual(refs.map((r) => r.specifier), ['.core', '.core.real']);
});

test('Python：docstring 被剥掉后行号不变', () => {
  const src = ['"""a', 'b', 'c', '"""', 'import os'].join('\n');
  const stripped = stripPythonDocstrings(src);
  assert.equal(stripped.split('\n').length, src.split('\n').length);
  const refs = parseImports('m.py', 'py', src);
  assert.equal(refs[0].line, 5);
});

test('Python：单行三引号不会吞掉后续代码', () => {
  const src = ['"""单行说明。"""', 'import os'].join('\n');
  const refs = parseImports('m.py', 'py', src);
  assert.deepEqual(refs.map((r) => r.specifier), ['os']);
});

test('generic：C 的引号 include 与尖括号 include 都能识别', () => {
  const src = ['#include "local.h"', '#include <stdio.h>', '  # include  "spaced.h"'].join('\n');
  const refs = parseImports('src/a.c', 'generic', src);
  assert.deepEqual(refs.map((r) => r.specifier), ['local.h', 'stdio.h', 'spaced.h']);
});

test('generic：块注释里的 include 被剥离', () => {
  const src = ['/*', '#include "ghost.h"', '*/', '#include "real.h"'].join('\n');
  const refs = parseImports('src/a.c', 'generic', src);
  assert.deepEqual(refs.map((r) => r.specifier), ['real.h']);
});

test('stripBlockComments 保留行结构', () => {
  const src = '/*a\nb*/\nint x;';
  assert.equal(stripBlockComments(src).split('\n').length, src.split('\n').length);
});

test('同一个 specifier 在同一行只记一次（去重）', () => {
  const src = "import a from './x'; import b from './x';";
  const refs = parseImports('x.ts', 'ts', src);
  assert.equal(refs.filter((r) => r.specifier === './x').length, 1);
});
