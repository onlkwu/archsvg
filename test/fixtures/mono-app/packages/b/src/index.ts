// 包 b 没有自己的 tsconfig，因此不应该认识 @core/* 这个别名
// （它只存在于包 a）。解析失败是正确行为，不是 bug。
import { helper } from '@core/helper';
import { event } from './event';

export function handle() {
  return `${helper}${event}`;
}
