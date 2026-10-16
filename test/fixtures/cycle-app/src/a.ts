// a -> b -> c -> a，外加 a 的自环
import { b } from './b';
import { a as selfA } from './a';

export function a() {
  return b() + selfA;
}
