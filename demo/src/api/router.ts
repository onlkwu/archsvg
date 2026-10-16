import { query } from '@db/client';
import { config } from '@core/config';
import { log } from '../utils/log';

export function createRouter(port: number, html: string) {
  log(`listen on ${port}, db=${config.dbUrl}`);
  return {
    port,
    handle(path: string) {
      if (path === '/') return html;
      return query('select 1');
    },
  };
}
