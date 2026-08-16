import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContextRepository, closeDatabase, migrateDatabase, openDatabase, recomputeMessageTokens } from '@luoli/db';
import { estimateMessageTokens, estimateStructureTokens, estimateTextTokens } from '@luoli/shared';
import { PromptAssembler, STABLE_PROMPT_BLOCKS } from '@luoli/core';

/**
 * token 估算的回归防线。三件事各自单独出过错，凑在一起把上下文水位推高了一个数量级：
 * ① `chars × 0.6` 一个系数同时描述中文和 ASCII，对整段请求高估约 65%；
 * ② base64 图片按字符估，一张图算成几万 token；
 * ③ 校准把「窗口内消息的估算」和「含系统提示词的真实用量」放在等号两边，首轮空上下文时
 *    一次采样就把系数推到 26 倍，而 tokens 是持久化的（logs/2026-08-16 的 ctx.token_calibration）。
 * 基线数据取自当天真实请求体：整段 input 的 cjk/other 字符数对应的真实 inputTokens。
 */
describe('token 估算', () => {
  it('中文与 ASCII 分档，整段请求落在真实用量的 ±10% 内', () => {
    // 2026-08-16 实测：cjk=8542 other=20190 → 真实 12,991 token；cjk=7674 other=9827 → 真实 9,644。
    for (const [cjk, other, real] of [[8542, 20190, 12_991], [7674, 9827, 9644]] as const) {
      const estimated = estimateTextTokens('中'.repeat(cjk) + 'a'.repeat(other));
      expect(Math.abs(estimated / real - 1)).toBeLessThan(0.1);
    }
    // 单一系数做不到这件事：0.6 × 全部字符对同一段输入高估 60% 以上。
    expect(Math.ceil((8542 + 20190) * 0.6) / 12_991).toBeGreaterThan(1.3);
  });

  it('base64 图片不按字符估', () => {
    const image = { type: 'image', image: 'A'.repeat(400_000), mediaType: 'image/jpeg' };
    expect(estimateMessageTokens([image])).toBeLessThan(3000);
    // 走 ModelMessage 那条路（in-flight 硬上限判定）也一样，否则每一步都会白白触发裁剪。
    expect(estimateStructureTokens([{ role: 'user', content: [image] }])).toBeLessThan(3000);
    // 但真正的长文本必须照实计价，不能被同一条规则一并压掉。
    expect(estimateStructureTokens([{ role: 'user', content: [{ type: 'text', text: '这是一段很长的中文'.repeat(2000) }] }])).toBeGreaterThan(10_000);
  });

  it('结构遍历与文本估算同尺，校准系数不吸收常数偏差', () => {
    // 校准拿「整段请求的估算」除出比值，再把比值乘回消息级估算。两个估算器不同尺的话，
    // 估算器自带的常数偏差会被吸收进系数、再反向压到消息上 —— 逐字符串 +4 就能让工具 schema
    // （全是三五个字符的键名）整体高估三成，系数跌到 0.74，消息随之被低估四分之一。
    const schema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`arg${index}`, { type: 'string', description: 'a path' }])) };
    const walked = estimateStructureTokens(schema);
    const flat = estimateTextTokens(JSON.stringify(schema));
    expect(walked / flat).toBeGreaterThan(0.7);
    expect(walked / flat).toBeLessThan(1.3);
  });

  it('校准系数被夹在合理量级内', () => {
    const path = './data/tokens-ratio.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const repo = new ContextRepository(db, 'chat:1');
    repo.ensure('1', null, 'chat');
    // 首轮那种「估算 30、真实 12000」的采样以前能把系数一次推到 26；现在最多推到上限。
    for (let round = 0; round < 20; round += 1) repo.updateTokenRatio(12_000, 30, 0.2);
    expect(repo.context()!.tokenRatio).toBeLessThanOrEqual(2);
    for (let round = 0; round < 40; round += 1) repo.updateTokenRatio(1, 12_000, 0.2);
    expect(repo.context()!.tokenRatio).toBeGreaterThanOrEqual(0.5);
    closeDatabase(db);
  });

  it('一次性修复按 parts 重算 tokens 并把校准系数归 1', () => {
    const path = './data/tokens-repair.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    migrateDatabase(db);
    const repo = new ContextRepository(db, 'chat:1');
    repo.ensure('1', null, 'chat');
    repo.insertTurn('turn-1', null, [{ id: 'm1', role: 'user', origin: 'trigger', parts: [{ type: 'text', text: '你好' }], tokens: 26_000, pruneLevel: 0 }], false);
    db.prepare("UPDATE contexts SET token_ratio=26 WHERE key='chat:1'").run();
    const repaired = recomputeMessageTokens(db);
    expect(repaired.messages).toBe(1);
    expect(db.prepare("SELECT tokens FROM context_messages WHERE key='chat:1'").pluck().get()).toBeLessThan(50);
    expect(repo.context()!.tokenRatio).toBe(1);
    closeDatabase(db);
  });
});

describe('系统提示词的缓存边界', () => {
  const built = new PromptAssembler().build({ character: 'CHAR', assist: 'ASSIST', catalog: 'CATALOG', publicMemory: 'PUB', privateMemory: 'PRI', runtime: '现在：2026年8月16日 21:35', maxTokens: 12_000 });

  it('每轮都变的块不落在缓存段里', () => {
    // 断点之后才是易变区。时钟留在缓存段里，等于每过一分钟整段前缀作废一次（实测跨轮只命中 128 token）。
    for (const header of ['=== KERNEL ===', '=== CHARACTER ===', '=== ASSIST ===', '=== TOOL CATALOG ===']) expect(built.stable).toContain(header);
    for (const header of ['=== PUBMEMORY ===', '=== PRIMEMORY ===', '=== RUNTIME ===']) {
      expect(built.stable).not.toContain(header);
      expect(built.volatile).toContain(header);
    }
    expect(STABLE_PROMPT_BLOCKS).not.toContain('runtime');
  });

  it('两段拼起来仍是文档规定的固定顺序', () => {
    const headers = ['=== KERNEL ===', '=== CHARACTER ===', '=== ASSIST ===', '=== TOOL CATALOG ===', '=== PUBMEMORY ===', '=== PRIMEMORY ===', '=== RUNTIME ==='];
    for (let index = 1; index < headers.length; index += 1) {
      expect(built.instructions.indexOf(headers[index - 1]!)).toBeLessThan(built.instructions.indexOf(headers[index]!));
    }
  });

  it('群聊没有私有记忆时易变段不留空标题', () => {
    const group = new PromptAssembler().build({ character: 'CHAR', assist: 'ASSIST', catalog: 'CATALOG', publicMemory: 'PUB', runtime: 'RUN', maxTokens: 12_000 });
    expect(group.volatile).not.toContain('PRIMEMORY');
    expect(group.instructions).not.toContain('PRIMEMORY');
  });
});
