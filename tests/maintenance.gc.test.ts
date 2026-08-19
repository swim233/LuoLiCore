import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, readAppKv } from '@luoli/db';
import { AGENT_RESULT_REF_REPAIR_KEY, AgentResultStore, MaintenanceService, repairAgentResultRefs } from '@luoli/core';

/**
 * 第十轮活体测试里维护那一批（`docs/reviews/28` 的 `L-OPS-05` / `L-OPS-06`）。
 * 两条都是「单测结构性看不见」的形状：一条要看 WAL 文件的字节数，一条要让库与目录来自两套部署。
 */

function database(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  return { db, path };
}
function directory(name: string): string {
  const path = resolve(`./data/${name}`);
  rmSync(path, { recursive: true, force: true }); mkdirSync(path, { recursive: true });
  return path;
}
const seedAgentRun = (db: ReturnType<typeof openDatabase>, id: string, ref: string | null, finishedAt = Date.now()): void => {
  db.prepare(`INSERT INTO agent_runs(id,turn_id,kind,agent_name,model_alias,effective_role,state,result_full_ref,started_at,finished_at)
    VALUES (?,?,'sub','a','main','owner','done',?,1,?)`).run(id, `t-${id}`, ref, finishedAt);
};

describe('L-OPS-05 · VACUUM 之后必须 checkpoint', () => {
  /**
   * `VACUUM` 在 WAL 模式下把整库重写一遍进 WAL，所以跑完这一刻 WAL 有整库那么大。实测 37MB 的
   * 库上 `POST /api/maintenance/vacuum` 期间 WAL 冲到 39,325,432 字节、**84 秒后仍是 38MB** ——
   * 一个「收缩主库」的动作让占盘翻倍，而 `db.vacuumCron` 是周日 5 点，于是这么挂约 23 小时。
   * 判据只能是 WAL 文件的字节数：库里的行数一个都不会变。
   */
  it('WAL 被 truncate 到 0 字节，而不是以整库大小挂着', () => {
    const { db, path } = database('maint28-vacuum');
    const insert = db.prepare(`INSERT INTO messages(chat_id,tg_message_id,direction,from_kind,kind,text,raw_json,tg_date,received_at)
      VALUES ('c',?,'in','user','text',?,'{}',1,1)`);
    db.transaction(() => { for (let index = 0; index < 400; index += 1) insert.run(index, 'x'.repeat(4096)); })();
    db.prepare('DELETE FROM messages').run();
    const wal = `${path}-wal`;
    expect(statSync(wal).size).toBeGreaterThan(0);
    const maintenance = new MaintenanceService(db, path, 2, 30, './data/maint28-vacuum-logs');
    maintenance.vacuum();
    // 旧实现：这里是整库大小（VACUUM 刚把整个库写进 WAL），要等下一次自动 checkpoint 攒够写入。
    expect(statSync(wal).size).toBe(0);
    closeDatabase(db);
  });
});

describe('L-OPS-06 · gcFiles 的错配保护要挡住部分错配', () => {
  /**
   * 此前的守卫只覆盖 `if (!referenced.size)` —— 只挡「一条带路径的行都没有」这种**全错配**，
   * 而它 docstring 自己描述的场景（`LUOLI_DATA_DIR` 指到别处）产生的是**部分错配**：
   * `referenced` 非空，守卫结构性地不可能触发。实测 `agent_runs` 269 行带 ref、其中 161 行指向
   * 另一个部署根，被删的正是「盘上在新根、库里记着旧根」那 74 份。
   */
  it('库里有行指向另一个根时拒绝清理，目标目录里的文件一个都不动', () => {
    const { db, path } = database('maint28-gc-partial');
    const oldRoot = directory('maint28-gc-partial-old');
    const newRoot = directory('maint28-gc-partial-new');
    const survivor = resolve(newRoot, 'r-moved.txt');
    writeFileSync(survivor, 'moved here by the operator');
    writeFileSync(resolve(newRoot, 'r-orphan.txt'), 'nobody points here');
    // 一行指着新根（正常），一行还记着旧根（搬过目录 / 换过 LUOLI_DATA_DIR 留下的）。
    seedAgentRun(db, 'r-moved', survivor);
    seedAgentRun(db, 'r-old', resolve(oldRoot, 'r-old.txt'));
    const maintenance = new MaintenanceService(db, path, 2, 30, './data/maint28-gc-partial-logs', { agentResults: newRoot });
    const result = maintenance.gcFiles();
    expect(result.agentResults).toBe(0);
    expect(result.refused).toHaveLength(1);
    const reason = String((result.refused as string[])[0]);
    expect(reason).toContain('1/2');
    expect(reason).toContain(resolve(oldRoot, 'r-old.txt'));
    // 这两条断言才是这个用例的全部意义：连真孤儿都不删 —— 判不准哪些是孤儿时不该动手。
    expect(existsSync(survivor)).toBe(true);
    expect(existsSync(resolve(newRoot, 'r-orphan.txt'))).toBe(true);
    closeDatabase(db);
  });

  it('两棵目录各自判定：一棵错配不连坐另一棵', () => {
    const { db, path } = database('maint28-gc-split');
    const filesDir = directory('maint28-gc-split-files');
    const resultsDir = directory('maint28-gc-split-results');
    writeFileSync(resolve(filesDir, 'orphan.jpg'), 'x'.repeat(16));
    db.prepare(`INSERT INTO messages(id,chat_id,tg_message_id,direction,from_kind,kind,raw_json,tg_date,received_at) VALUES (1,'c',1,'in','user','photo','{}',1,1)`).run();
    db.prepare(`INSERT INTO attachments(id,message_id,chat_id,kind,tg_file_id,tg_file_unique_id,local_path,download_state,extract_state,created_at)
      VALUES ('a1',1,'c','photo','f','u',?,'done','skipped',1)`).run(relative(process.cwd(), resolve(filesDir, 'kept.jpg')));
    writeFileSync(resolve(filesDir, 'kept.jpg'), 'y'.repeat(8));
    seedAgentRun(db, 'r-far', '/somewhere/else/r-far.txt');
    const maintenance = new MaintenanceService(db, path, 2, 30, './data/maint28-gc-split-logs', { files: filesDir, agentResults: resultsDir });
    const result = maintenance.gcFiles();
    // 媒体那一棵照常清（`local_path` 存的是 cwd 相对路径，与 walk 用同一个基准归一化）。
    expect(result.files).toBe(1);
    expect(existsSync(resolve(filesDir, 'kept.jpg'))).toBe(true);
    expect(result.refused).toHaveLength(1);
    expect(String((result.refused as string[])[0])).toContain('agent_runs');
    closeDatabase(db);
  });

  /**
   * 反面：正常部署不能被这道保护误伤。`local_path` 的 cwd 相对路径、结果目录的相对 ref、
   * 子目录里的文件三种形态都算「目录内」。
   */
  it('全部 ref 都落在目录内时照常清孤儿，不报 refused', () => {
    const { db, path } = database('maint28-gc-happy');
    const filesDir = directory('maint28-gc-happy-files');
    const resultsDir = directory('maint28-gc-happy-results');
    mkdirSync(resolve(filesDir, 'chat-1'), { recursive: true });
    const kept = resolve(filesDir, 'chat-1', 'kept.jpg');
    writeFileSync(kept, 'x'.repeat(10));
    writeFileSync(resolve(filesDir, 'chat-1', 'orphan.jpg'), 'y'.repeat(20));
    const store = new AgentResultStore(resultsDir);
    const ref = store.put('r-kept', 'full transcript');
    writeFileSync(resolve(resultsDir, 'r-orphan.txt'), 'nobody points here');
    db.prepare(`INSERT INTO messages(id,chat_id,tg_message_id,direction,from_kind,kind,raw_json,tg_date,received_at) VALUES (1,'c',1,'in','user','photo','{}',1,1)`).run();
    db.prepare(`INSERT INTO attachments(id,message_id,chat_id,kind,tg_file_id,tg_file_unique_id,local_path,download_state,extract_state,created_at)
      VALUES ('a1',1,'c','photo','f','u',?,'done','skipped',1)`).run(relative(process.cwd(), kept));
    seedAgentRun(db, 'r-kept', ref);
    const maintenance = new MaintenanceService(db, path, 2, 30, './data/maint28-gc-happy-logs', { files: filesDir, agentResults: resultsDir });
    const swept = maintenance.gcFiles();
    expect(swept).toMatchObject({ files: 1, fileBytes: 20, agentResults: 1 });
    expect(swept.refused).toBeUndefined();
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(resolve(resultsDir, 'r-kept.txt'))).toBe(true);
    closeDatabase(db);
  });
});

describe('L-OPS-06 · result_full_ref 存相对路径', () => {
  it('put 落库的是相对 ref，read 按当前目录拼回去 —— 目录整体搬走也读得到', () => {
    const moved = directory('maint28-ref-moved');
    const original = directory('maint28-ref-original');
    const ref = new AgentResultStore(original).put('r1', '完整结果');
    expect(ref).toBe('r1.txt');
    // 「搬过一次目录」在这里就是：同一个 ref，换一个 store 去读。
    writeFileSync(resolve(moved, 'r1.txt'), '完整结果');
    expect(new AgentResultStore(moved).read(ref, 0, 100).content).toBe('完整结果');
    // 存量绝对路径行（归一化时指向别的根、原样留下的那些）照旧能读。
    expect(new AgentResultStore(moved).read(resolve(original, 'r1.txt'), 0, 100).content).toBe('完整结果');
    // 文件真没了才回那句「已按保留期清理」，而不是抛一个与原因无关的 ENOENT。
    expect(new AgentResultStore(moved).read('r-gone.txt', 0, 100).content).toContain('保留期');
  });

  it('cleanup 按相对 ref 找到文件、删它、把列置空', () => {
    const { db, path } = database('maint28-ref-cleanup');
    const resultsDir = directory('maint28-ref-cleanup-results');
    const ref = new AgentResultStore(resultsDir).put('r1', '完整结果');
    seedAgentRun(db, 'r1', ref, Date.now() - 40 * 86_400_000);
    const maintenance = new MaintenanceService(db, path, 2, 30, './data/maint28-ref-cleanup-logs', { agentResults: resultsDir });
    expect(maintenance.cleanup()).toMatchObject({ agentResults: 1 });
    expect(existsSync(resolve(resultsDir, 'r1.txt'))).toBe(false);
    expect(db.prepare("SELECT result_full_ref FROM agent_runs WHERE id='r1'").pluck().get()).toBeNull();
    closeDatabase(db);
  });

  /**
   * 存量归一化：**只动前缀恰好是当前目录的那些**。指向另一个根的行原样留下 —— 那是「库与目录
   * 来自两套部署」的唯一信号，`gcFiles()` 要靠它拒绝清理。悄悄一起改成相对路径等于把证据擦掉，
   * 然后 gc 会照着删，那就是这条缺陷本身。
   */
  it('一次性归一化改写本根的绝对路径，指向别的根的原样留下并报出来', () => {
    const { db } = database('maint28-ref-repair');
    const root = directory('maint28-ref-repair-results');
    seedAgentRun(db, 'r-here', resolve(root, 'r-here.txt'));
    seedAgentRun(db, 'r-there', '/another/deploy/agent-results/r-there.txt');
    seedAgentRun(db, 'r-rel', 'r-rel.txt');
    seedAgentRun(db, 'r-null', null);
    const repair = repairAgentResultRefs(db, root);
    expect(repair).toMatchObject({ scanned: 3, rewritten: 1, foreign: 1, relative: 1, sample: '/another/deploy/agent-results/r-there.txt' });
    expect(db.prepare("SELECT result_full_ref FROM agent_runs WHERE id='r-here'").pluck().get()).toBe('r-here.txt');
    expect(db.prepare("SELECT result_full_ref FROM agent_runs WHERE id='r-there'").pluck().get()).toBe('/another/deploy/agent-results/r-there.txt');
    expect(db.prepare("SELECT result_full_ref FROM agent_runs WHERE id='r-rel'").pluck().get()).toBe('r-rel.txt');
    // 门闸：跑过一次就返回 null，不会在每次启动时再扫一遍全表。
    expect(readAppKv<boolean>(db, AGENT_RESULT_REF_REPAIR_KEY)).toBe(true);
    expect(repairAgentResultRefs(db, root)).toBeNull();
    closeDatabase(db);
  });

  /**
   * 归一化之后同一棵目录搬到别处，gc 不再误判 —— 这条是 `L-OPS-06` 的完整闭环：
   * 报告实测被删的正是「盘上在新根、库里记着旧根」那批全文。
   */
  it('归一化之后换根，ref 仍然指得到，gc 不再把它们当孤儿', () => {
    const { db, path } = database('maint28-ref-rootswap');
    const oldRoot = directory('maint28-ref-rootswap-old');
    const newRoot = directory('maint28-ref-rootswap-new');
    const ref = new AgentResultStore(oldRoot).put('r1', '完整结果');
    seedAgentRun(db, 'r1', resolve(oldRoot, 'r1.txt'));   // 旧写法：绝对路径
    // 换根 = 文件跟着搬过去，库里那一行还记着旧位置。
    writeFileSync(resolve(newRoot, 'r1.txt'), '完整结果');
    rmSync(resolve(oldRoot, 'r1.txt'));
    const service = (dir: string) => new MaintenanceService(db, path, 2, 30, './data/maint28-ref-rootswap-logs', { agentResults: dir });
    // 归一化之前：这就是那次误删的形状 —— 现在被挡下来。
    expect(service(newRoot).gcFiles().refused).toHaveLength(1);
    // 归一化只认「前缀恰好是当前目录」的行；这里模拟运维照 refused 的提示把行改到当前目录之后再跑
    // （门闸行清掉才跑得起第二次 —— 生产上这一步是运维自己做的，所以修复不会偷偷重跑）。
    db.prepare('DELETE FROM app_kv WHERE key=?').run(AGENT_RESULT_REF_REPAIR_KEY);
    db.prepare("UPDATE agent_runs SET result_full_ref=? WHERE id='r1'").run(resolve(newRoot, 'r1.txt'));
    expect(repairAgentResultRefs(db, newRoot)).toMatchObject({ rewritten: 1, foreign: 0 });
    expect(db.prepare("SELECT result_full_ref FROM agent_runs WHERE id='r1'").pluck().get()).toBe(ref);
    // 从此这一行免疫换根：同一个 ref 在两棵目录下都解析得到，gc 都不会把它当孤儿。
    const afterSwap = service(newRoot).gcFiles();
    expect(afterSwap).toMatchObject({ agentResults: 0 });
    expect(afterSwap.refused).toBeUndefined();
    expect(existsSync(resolve(newRoot, 'r1.txt'))).toBe(true);
    writeFileSync(resolve(oldRoot, 'r1.txt'), '完整结果');
    const backOnOld = service(oldRoot).gcFiles();
    expect(backOnOld).toMatchObject({ agentResults: 0 });
    expect(backOnOld.refused).toBeUndefined();
    expect(existsSync(resolve(oldRoot, 'r1.txt'))).toBe(true);
    closeDatabase(db);
  });
});
