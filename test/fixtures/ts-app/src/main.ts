// 应用入口：只做装配，依赖 api 与 ui 两层
import { startServer } from './api/server';
import { renderPage } from './ui/page';
import { formatDate } from './utils/format';

export async function main() {
  const html = renderPage(formatDate(new Date()));
  await startServer(html);
}

main();
