import { describe, expect, it } from 'vitest';
import { PromptAssembler } from '@luoli/core';

describe('prompt assembler', () => {
  it('uses the fixed documented private block order', () => {
    const result = new PromptAssembler().build({ character: 'CHAR', assist: 'ASSIST', catalog: 'CATALOG', publicMemory: 'PUB', privateMemory: 'PRI', runtime: 'RUN', maxTokens: 12_000 });
    const headers = ['=== KERNEL ===', '=== CHARACTER ===', '=== ASSIST ===', '=== TOOL CATALOG ===', '=== PUBMEMORY ===', '=== PRIMEMORY ===', '=== RUNTIME ==='];
    for (let index = 1; index < headers.length; index += 1) {
      expect(result.instructions.indexOf(headers[index - 1]!)).toBeLessThan(result.instructions.indexOf(headers[index]!));
    }
  });

  it('omits private memory from group prompts', () => {
    const result = new PromptAssembler().build({ character: 'CHAR', assist: 'ASSIST', catalog: 'CATALOG', publicMemory: 'PUB', runtime: 'RUN', maxTokens: 12_000 });
    expect(result.instructions).not.toContain('PRIMEMORY');
  });
});
