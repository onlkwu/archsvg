import { log } from './log';
// 自环：自己引用自己，用来验证环检测会把它算作一组环（但它不会画成弧线，
// 因为自指边在图上不表示任何信息）
import { toSql as self } from './sql';

export function toSql(raw: string) {
  log('toSql');
  return self ? raw.trim() : raw;
}
