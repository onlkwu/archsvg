// 注意：这一层故意越界直接访问 db，用来演示 --check 能抓到架构漂移
import { query } from '../db/client';
import { formatDate } from '../utils/date';

export function renderDashboard(today: string) {
  const row = query('select count(*) as n from users');
  return `<h1>${formatDate(new Date(today))}</h1><p>${row}</p>`;
}
