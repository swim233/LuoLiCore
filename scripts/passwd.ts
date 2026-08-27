import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";

export const MIN_PASSWORD_LENGTH = 12;

/**
 * 与 `apps/bot/src/main.ts` 的 `envOverlay`（`WEBUI_PASSWORD` → `webui.passwordHash`）同一组参数。
 * 两处算出来的哈希必须可互换，所以别名的参数只此一份 —— 抄一份的代价是某天两条路的
 * memoryCost 不一样，而验证是通过的，没人会发现。
 */
export const hashWebuiPassword = (password: string): Promise<string> =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

/**
 * 这个文件同时是 CLI（`pnpm webui:passwd`）与被 import 的模块（`scripts/acceptance/seed.ts`）。
 * 不判「是不是我自己被直接跑起来的」的话，import 一次就会在加载期因为缺 `argv[2]` 抛出来。
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
