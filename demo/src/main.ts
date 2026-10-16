// 应用装配层：只做接线，是所有依赖的起点
import { createRouter } from './api/router';
import { renderDashboard } from './ui/dashboard';
import { formatDate } from './utils/date';
import { config } from './core/config';

export function bootstrap() {
  const today = formatDate(new Date());
  const html = renderDashboard(today);
  return createRouter(config.port, html);
}
