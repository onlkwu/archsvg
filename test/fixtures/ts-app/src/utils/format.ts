export function formatDate(d: Date) {
  return d.toISOString().slice(0, 10);
}
