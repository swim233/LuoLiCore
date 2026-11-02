import { fileURLToPath } from 'node:url';
import { createPromptFiles, type PromptSource } from './prompt-files.js';

/**
 * 测试用的内置提示目录：搬出时原文的一份固定副本（含 system.md），测试里逐字核对的就是它。
 * 仓库的 prompts/ 随时会调，测试不读它的内容，改了措辞也不影响测试
 */
export const fixturePrompts = fileURLToPath(new URL('./fixtures/prompts/', import.meta.url));

/** 测试用的提示词来源：固定副本里的内置提示照常每次读，人设换成给定的文字 */
export function testPrompts(persona: string): PromptSource {
  const files = createPromptFiles({ dir: fixturePrompts });
  return { load: async () => ({ ...(await files.load()), persona }) };
}
