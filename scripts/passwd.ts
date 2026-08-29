import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";

export const MIN_PASSWORD_LENGTH = 12;

/**
 * 与 `apps/bot/src/main.ts` 的 `envOverlay`（`WEBUI_PASSWORD` → `webui.passwordHash`）使用同一组参数。
 * 两处计算出的哈希必须可互换，因此参数只保留这一份：复制第二份的后果是两条路径的
 * memoryCost 出现差异，而校验仍然通过，该问题不会被发现。
 */
export const hashWebuiPassword = (password: string): Promise<string> =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

/**
 * 该文件同时作为 CLI（`pnpm webui:passwd`）与被 import 的模块（`scripts/acceptance/seed.ts`）。
 * 不判断是否为直接执行时，一次 import 会在加载期因缺少 `argv[2]` 抛出异常。
 */
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const password = process.argv[2];
  if (!password || password.length < MIN_PASSWORD_LENGTH)
    throw new Error(
      `Usage: pnpm webui:passwd <password of at least ${MIN_PASSWORD_LENGTH} characters>`,
    );
  process.stdout.write(`${await hashWebuiPassword(password)}\n`);
}
