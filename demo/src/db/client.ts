import { toSql } from '../utils/sql';
import { log } from '../utils/log';

export function query(statement: string) {
  log(`query ${statement}`);
  return toSql(statement);
}
