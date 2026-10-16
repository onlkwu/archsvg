// 这一层故意违规：ui 直接引用了 db
import { queryUser } from '../db/client';

export function renderPage(date: string) {
  const user = queryUser('1');
  return `<html><body>${date} ${user.name}</body></html>`;
}
