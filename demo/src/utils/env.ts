export function readEnv(key: string, fallback: string) {
  return process.env[key] ?? fallback;
}
