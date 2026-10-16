import { readEnv } from '../utils/env';

export interface Config {
  port: number;
  dbUrl: string;
}

export const config: Config = {
  port: Number(readEnv('PORT', '3000')),
  dbUrl: readEnv('DATABASE_URL', 'sqlite::memory:'),
};
