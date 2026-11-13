import { useSyncExternalStore } from 'react';

/* 地址里 # 后面的一段就是当前这一节（#tokens、#scale……）：直接打开地址就到那一节，QA 的脚本靠它定位。
   不认识的、没写的都回到 fallback（不改地址栏） */
export function routeFromHash(hash: string, valid: readonly string[], fallback: string) {
  const id = hash.replace(/^#/, '');
  return valid.includes(id) ? id : fallback;
}

export function useHashRoute(valid: readonly string[], fallback: string) {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener('hashchange', fn);
      return () => window.removeEventListener('hashchange', fn);
    },
    () => routeFromHash(location.hash, valid, fallback),
  );
}
