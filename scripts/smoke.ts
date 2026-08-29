import { rmSync } from "node:fs";
import {
  ArchiveRepository,
  ContextRepository,
  closeDatabase,
  migrateDatabase,
  openDatabase,
} from "@luoli/db";
import { ContextEngine, configSchema } from "@luoli/core";

const path = "./data/smoke.db";
for (const suffix of ["", "-wal", "-shm"])
  rmSync(`${path}${suffix}`, { force: true });
const db = openDatabase(path);
migrateDatabase(db);
const archive = new ArchiveRepository(db);
const engine = new ContextEngine(db, archive);
// 使用 `configSchema.parse` 而不是手写 `as never`：手写版本在每新增一处配置读取时都会在此处得到
// undefined，而冒烟脚本的价值在于验证装配后可正常运行，不应因无关的新配置项而失败。
const smokeConfig = configSchema.parse({
  general: { timezone: "UTC" },
  context: {
    scope: "chat",
    background: { enabled: true, maxPerTurn: 20 },
    rebase: { injectNotice: false },
    limit: { tokens: 32_000, maxMessages: 200, minKeepTurns: 1 },
  },
});
for (let index = 1; index <= 20; index += 1) {
  const scoped = archive.scope("smoke", null);
  const message = scoped.append({
    chatId: "smoke",
    messageThreadId: null,
    tgMessageId: index,
    direction: "in",
    fromKind: "user",
    fromUserId: "user",
    fromName: "Smoke",
    fromUsername: null,
    kind: "text",
    text: `message ${index}`,
    tgDate: Date.now(),
    raw: {},
    triggered: index % 2 === 0,
    triggerReason: index % 2 === 0 ? "mention" : null,
  });
  if (index % 2) continue;
  const controller = new AbortController();
  const config = smokeConfig;
  const turn = await engine.openTurn({
    chatId: "smoke",
    threadId: null,
    key: "chat:smoke",
    initiatorUserId: "user",
    effectiveRole: "trusted",
    isPrivate: false,
    trigger: message,
    abortSignal: controller.signal,
    config,
  });
  engine.appendDelta(turn, {
    id: `answer-${index}`,
    role: "assistant",
    origin: "assistant",
    parts: [{ type: "text", text: `answer ${index}` }],
    pruneLevel: 0,
  });
  await engine.commitTurn(turn);
}
const repo = new ContextRepository(db, "chat:smoke");
const head = repo.head();
const messages = repo.messages(head);
if (
  !head ||
  messages.length !== 30 ||
  messages.some((message, index) => message.ordinal !== index + 1)
)
  throw new Error(
    `Smoke assertion failed: ${JSON.stringify({ head, messages: messages.length })}`,
  );
process.stdout.write(
  JSON.stringify({
    ok: true,
    updates: 20,
    turns: 10,
    messages: messages.length,
    head: head.id,
  }) + "\n",
);
closeDatabase(db);
