/* localStorage 可能不可用（隐私窗口、禁用存储）：读写都包 try/catch，失败时页面照常工作 */
export const storage = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* 存不了就算了 */
    }
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* 同上 */
    }
  },
};
