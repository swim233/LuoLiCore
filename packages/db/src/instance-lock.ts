import { hostname } from 'node:os';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * **进程级互斥。** 部署是单进程（`docs/01 §3.1`），而在这之前没有任何东西保证这一点：
 * 没有文件锁、没有 DB 锁、没有 PID 检查。代价实测过 —— 用同一个库起第二个实例，
 * `recoverAfterCrash` 无条件把在位实例**仍在执行**的那条轮次改成
 * `state='failed', error='process_restarted'`，顺带释放已认领的消息、清零在途预留额度，
 * 之后 A 才因为 409 关停：**赢的是后来者**。本机误跑一次 `pnpm dev` 就足够
 * （`tests/shutdown.test.ts` 自己警告过它会抢走长轮询）。`docs/reviews/28 · L-OPS-01`
 *
 * 锁文件放在库旁边（`<db.path>.lock`）而不是固定的 `data/`：被守的是**那个库**，
 * 跟着 `LUOLI_DATA_DIR` 与自定义 `db.path` 走，两个各自有库的实例本来就不该互相挡。
 * 它同时落在 `tools.fs.denyGlobs` 的 `<root>/data/luoli.db*` 里面，模型碰不到。
 *
 * **不用 `better-sqlite3` 的写锁代替**：WAL 下两个写进程可以正常交替写，`busy_timeout=5000`
 * 只在真的撞上同一页时才说话 —— 第十轮实测 7 路并发压库 `SQLITE_BUSY` 是 0 条，
 * 那道机制结构上挡不住这件事。
 */
export interface InstanceLock {
  readonly path: string;
  /** 抢占了一把主人已经死掉的锁时，写下原来那个 pid —— 上一次是崩溃退出的证据。 */
  readonly stolenFrom: number | null;
  release(): void;
}

export interface InstanceLockHolder { pid: number; startedAt: number; host: string }

export type InstanceLockResult = { ok: true; lock: InstanceLock } | { ok: false; holder: InstanceLockHolder };

const holderOf = (path: string): InstanceLockHolder | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstanceLockHolder>;
    return typeof parsed.pid === 'number' && parsed.pid > 0
      ? { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0, host: typeof parsed.host === 'string' ? parsed.host : '?' }
      : null;
  } catch { return null; }        // 锁文件被手工改坏 / 读不出来 = 当成没有主人
};

/**
 * `EPERM` 当**活着**处理：进程存在但属于别的用户。这里宁可拒绝启动 —— 判错的代价是
 * 「要人手动删一个锁文件」，反过来判错的代价是上面那条把在位实例的在途状态清掉。
 */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as { code?: string }).code === 'EPERM'; }
};

export function acquireInstanceLock(databasePath: string): InstanceLockResult {
  const path = `${resolve(databasePath)}.lock`;
  const mine: InstanceLockHolder = { pid: process.pid, startedAt: Date.now(), host: hostname() };
  const payload = JSON.stringify(mine);
  const held = (stolenFrom: number | null): InstanceLockResult => ({
    ok: true,
    lock: {
      path, stolenFrom,
      // 只删还写着自己 pid 的那把：别把接手的人的锁删掉（关停很慢时对方可能已经抢占过了）。
      release: () => { if (holderOf(path)?.pid === process.pid) try { unlinkSync(path); } catch { /* 已经没了 */ } },
    },
  });
  try {
    writeFileSync(path, payload, { flag: 'wx', mode: 0o600 });
    return held(null);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const holder = holderOf(path);
  if (holder && holder.pid !== process.pid && alive(holder.pid)) return { ok: false, holder };
  // 主人已经死了（或锁文件坏了）：抢占之后**回读一次**。两个进程同时看到同一把死锁时都会写，
  // 而回读只有最后那个能看见自己的 pid —— 恰好一个赢，另一个照常被拒。
  writeFileSync(path, payload, { mode: 0o600 });
  const after = holderOf(path);
  if (after?.pid !== process.pid) return { ok: false, holder: after ?? { pid: 0, startedAt: 0, host: '?' } };
  return held(holder?.pid ?? null);
}
