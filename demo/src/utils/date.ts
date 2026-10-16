import { log } from './log';
import { readEnv } from './env';

export function formatDate(d: Date) {
  log('formatDate');
  return `${readEnv('TZ', 'UTC')} ${d.toISOString().slice(0, 10)}`;
}
