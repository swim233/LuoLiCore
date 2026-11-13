/* 把库的类名和使用方传进来的 className 拼在一起（库的在前） */
export const cx = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);
