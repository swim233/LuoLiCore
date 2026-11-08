import { useSyncExternalStore } from 'react';

/* 极简外部 store：状态层都用它，组件用 useStore(store, selector) 订阅；频繁更新的数据（终端、状态徽记）也走外部 store，不重渲染整棵树 */
export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: () => void): () => void;
}
export function createStore<S extends object>(init: S): Store<S> {
  let state = init;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
export function useStore<S, R>(store: Store<S>, selector: (s: S) => R): R {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
