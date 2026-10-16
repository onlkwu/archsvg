export function queryUser(id: string) {
  return { id, name: `user-${id}` };
}
