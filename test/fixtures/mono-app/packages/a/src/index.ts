// 包 a 需要用到自己的别名，并且不应该受影响于根配置里不存在的路径
import { helper } from '@core/helper';
import { readFile } from 'node:fs/promises';
import { join } from 'path';

export function run(name: string) {
  return readFile(join(helper(), name), 'utf8');
}
