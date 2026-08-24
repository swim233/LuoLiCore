import { hostname } from "node:os";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
 * 旁边可能多一个 `<db.path>.lock.<n>`：那是抢占死锁用的 claim（见下面 `acquireInstanceLock`），
 * 正常关停会跟着删。手工恢复时 `.lock` 与 `.lock.<n>` 一起删掉也行 —— claim 只在抢占那一刻被看。
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

export interface InstanceLockHolder {
  pid: number;
  startedAt: number;
  host: string;
  /** 这把锁被接手过几次。抢占按代走，判胜负的就是这个数（`acquireInstanceLock`）。 */
  gen: number;
}

export type InstanceLockResult =
  { ok: true; lock: InstanceLock } | { ok: false; holder: InstanceLockHolder };

const holderOf = (path: string): InstanceLockHolder | null => {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<InstanceLockHolder>;
    return typeof parsed.pid === "number" && parsed.pid > 0
      ? {
          pid: parsed.pid,
          startedAt:
            typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
          host: typeof parsed.host === "string" ? parsed.host : "?",
          gen:
            typeof parsed.gen === "number" && parsed.gen >= 0
              ? Math.floor(parsed.gen)
              : 0,
        }
      : null;
  } catch {
    return null;
  } // 锁文件被手工改坏 / 读不出来 = 当成没有主人
};

/**
 * `EPERM` 当**活着**处理：进程存在但属于别的用户。这里宁可拒绝启动 —— 判错的代价是
 * 「要人手动删一个锁文件」，反过来判错的代价是上面那条把在位实例的在途状态清掉。
 */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

/** 一次启动最多往上找这么多代。走到头意味着连着这么多代都被已死的进程占过，不该发生。 */
const MAX_STEAL_GENERATIONS = 32;

/**
 * 抢占死锁**必须由一次原子操作定胜负**。写完回读定不了：write 与 read 是两次独立 syscall，
 * `write(A) → read(A) → write(B) → read(B)` 下两个进程都能读到自己的 pid，于是两个实例一起
 * 进 `recoverAfterCrash` —— 正是这把锁要挡的那件事。删掉再 `wx` 也定不了：两边都能删成、
 * 都能建成。
 *
 * 所以判胜负的是「谁独占创建成了这一代的 claim 文件」（`<db.path>.lock.<n>`，`flag:'wx'`，
 * 与首次获取同一个原语）：同一代只有一个进程能建出来，输的那个看见 claim 里那个活着的 pid，
 * 照常被拒。代号从锁文件里记的 `gen` 往上走，所以抢占者崩在「建了 claim 还没装上锁文件」
 * 那一刻也不会把人永久锁在外面 —— 下一个进程发现那一代的 claim 属于死进程，往下一代继续找。
 */
export function acquireInstanceLock(databasePath: string): InstanceLockResult {
  const path = `${resolve(databasePath)}.lock`;
  const claimPath = (gen: number): string => `${path}.${gen}`;
  const payload = (gen: number): string =>
    JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      host: hostname(),
      gen,
    } satisfies InstanceLockHolder);
  const held = (
    stolenFrom: number | null,
    gen: number,
  ): InstanceLockResult => ({
    ok: true,
    lock: {
      path,
      stolenFrom,
      // 只删还写着自己 pid 的那把：别把接手的人的锁删掉（关停很慢时对方可能已经抢占过了）。
      // 自己那一代的 claim 跟着删，否则下一次抢占要先空转过这一代。
      release: () => {
        if (holderOf(path)?.pid === process.pid)
          try {
            unlinkSync(path);
          } catch {
            /* 已经没了 */
          }
        if (gen > 0 && holderOf(claimPath(gen))?.pid === process.pid)
          try {
            unlinkSync(claimPath(gen));
          } catch {
            /* 同上 */
          }
      },
    },
  });
  try {
    writeFileSync(path, payload(0), { flag: "wx", mode: 0o600 });
    return held(null, 0);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
  const holder = holderOf(path);
  if (holder && holder.pid !== process.pid && alive(holder.pid))
    return { ok: false, holder };
  const from = holder?.gen ?? 0;
  for (let gen = from + 1; gen <= from + MAX_STEAL_GENERATIONS; gen += 1) {
    try {
      writeFileSync(claimPath(gen), payload(gen), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const claimed = holderOf(claimPath(gen));
      // 这一代被别人拿了：他活着就是在位实例（他刚接手，或正在接手）。他也死了就往下一代找 ——
      // 删掉这个 claim 再重建等于把上面那条原子性还回去（两个进程可以一起删、一起建）。
      if (claimed && claimed.pid !== process.pid && alive(claimed.pid))
        return { ok: false, holder: claimed };
      continue;
    }
    // 这一代归自己了。装锁文件之前再核一次：这段时间里锁文件被人手删掉、又被一个新进程以第 0 代
    // 独占建起来时，覆盖它就是把两个实例都放进去。自己那个 claim 顺手删掉 —— 独占持有的东西，
    // 删它不影响别人的胜负判定。
    const current = holderOf(path);
    if (current && current.pid !== process.pid && alive(current.pid)) {
      try {
        unlinkSync(claimPath(gen));
      } catch {
        /* 已经没了 */
      }
      return { ok: false, holder: current };
    }
    writeFileSync(path, payload(gen), { mode: 0o600 });
    for (let old = gen - 1; old > 0; old -= 1)
      try {
        unlinkSync(claimPath(old));
      } catch {
        /* 没有就算了 */
      }
    return held(holder?.pid ?? null, gen);
  }
  return {
    ok: false,
    holder: holderOf(path) ?? { pid: 0, startedAt: 0, host: "?", gen: from },
  };
}
