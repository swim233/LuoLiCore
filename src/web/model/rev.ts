import { useEffect, useState } from 'react';
import { bus } from './bus';
import type { BusEventName } from './bus';

/* 订阅一组总线事件，事件来了就重渲染（列表、缩略文字这类由数据算出的东西用） */
export function useBusRev(types: BusEventName[]) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const offs = types.map((t) => bus.on(t, () => setN((x) => x + 1)));
    return () => offs.forEach((f) => f());
  }, []);
  return n;
}
