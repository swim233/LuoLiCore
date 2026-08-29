import { hostname } from "node:os";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 进程级互斥。部署为单进程（`docs/01 §3.1`），而在此之前没有任何机制保证这一点：既无文件锁，
 * 也无 DB 锁与 PID 检查。代价已实测：用同一个库启动第二个实例时，`recoverAfterCrash` 会无条件把
 * 在位实例仍在执行的轮次改为 `state='failed', error='process_restarted'`，同时释放已认领的消息、
 * 清零在途预留额度，之后在位实例才因 409 关停，结果是后启动者胜出。本机误跑一次 `pnpm dev`
 * 即可触发（`tests/shutdown.test.ts` 中已警告它会抢走长轮询）。`docs/reviews/28 · L-OPS-01`
 *
 * 锁文件放在库文件旁（`<db.path>.lock`）而非固定的 `data/`：被保护的是该数据库，因此跟随
 * `LUOLI_DATA_DIR` 与自定义 `db.path`，两个各自持有独立数据库的实例本就不应互相阻塞。
 * 该路径同时落在 `tools.fs.denyGlobs` 的 `<root>/data/luoli.db*` 内，模型无法访问。
 * 旁边可能存在 `<db.path>.lock.<n>`：那是抢占死锁用的 claim（见下方 `acquireInstanceLock`），
 * 正常关停时一并删除。手工恢复时可将 `.lock` 与 `.lock.<n>` 一起删除，claim 只在抢占瞬间被读取。
 *
 * 不使用 `better-sqlite3` 的写锁替代：WAL 模式下两个写进程可以正常交替写入，`busy_timeout=5000`
 * 只在真正冲突于同一页时才生效。第十轮实测 7 路并发压库 `SQLITE_BUSY` 为 0 条，
 * 该机制结构上无法阻止此问题。
 */
export interface InstanceLock {
  readonly path: string;
  /** 抢占持有者已终止的锁时记录原 pid，作为上一次为崩溃退出的证据。 */
  readonly stolenFrom: number | null;
  release(): void;
}

export interface InstanceLockHolder {
  pid: number;
  startedAt: number;
  host: string;
  /** 该锁被接手的次数。抢占按代进行，胜负判据即此计数（`acquireInstanceLock`）。 */
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
  } // 锁文件损坏或读取失败时按无持有者处理
};

/**
 * `EPERM` 按进程存活处理：进程存在但属于其他用户。此处宁可拒绝启动，因为误判为存活的代价只是
 * 需要人工删除一个锁文件，而误判为已终止的代价是清掉在位实例的在途状态。
 */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

/** 单次启动向上查找的最大代数。耗尽意味着连续这么多代都被已终止的进程占用过，属于异常情况。 */
const MAX_STEAL_GENERATIONS = 32;

/**
 * 抢占死锁必须由一次原子操作定胜负。写后回读无法定胜负：write 与 read 是两次独立 syscall，
 * 在 `write(A) → read(A) → write(B) → read(B)` 时序下两个进程都能读到自己的 pid，于是两个实例
 * 同时进入 `recoverAfterCrash`，而这正是本锁要阻止的情况。先删除再以 `wx` 创建同样无法定胜负：
 * 两边都能删除成功、都能创建成功。
 *
 * 因此胜负判据是「谁独占创建了本代的 claim 文件」（`<db.path>.lock.<n>`，`flag:'wx'`，与首次获取
 * 使用同一原语）：同一代只有一个进程能创建成功，失败方读到 claim 中存活的 pid 后照常被拒。
 * 代号自锁文件记录的 `gen` 递增，因此抢占者即使在「已建 claim 但未写入锁文件」时崩溃也不会永久
 * 锁死他人：下一个进程发现该代 claim 属于已终止进程，继续查找下一代。
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
      // 只删除仍写着本进程 pid 的锁，避免删掉接手者的锁（关停缓慢时对方可能已完成抢占）。
      // 同时删除本代的 claim，否则下一次抢占需要先空转过这一代。
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
      // 本代已被他人取得：对方存活即为在位实例（刚接手或正在接手）。对方也已终止则查找下一代；
      // 删除该 claim 后重建会放弃上述原子性（两个进程可以同时删除、同时创建）。
      if (claimed && claimed.pid !== process.pid && alive(claimed.pid))
        return { ok: false, holder: claimed };
      continue;
    }
    // 本代已归本进程。写入锁文件前再核对一次：若期间锁文件被人工删除、又被新进程以第 0 代独占创建，
    // 覆盖它会导致两个实例同时运行。同时删除本进程的 claim：它是独占持有的对象，
    // 删除不影响其他进程的胜负判定。
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
