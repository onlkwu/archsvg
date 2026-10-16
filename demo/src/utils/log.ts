// 故意与 date.ts 形成循环依赖，用来演示环检测
import { formatDate } from './date';

export function log(message: string) {
  return `[${formatDate(new Date())}] ${message}`;
}
