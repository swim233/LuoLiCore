import { describe, expect, it } from 'vitest';
import { parseCommand } from './command.js';

describe('认指令', () => {
  it.each([
    ['/compact', 'compact'],
    ['/clear', 'clear'],
    [' /CLEAR ', 'clear'],
    ['/Compact', 'compact'],
    ['\t/clear\n', 'clear'],
  ] as const)('%j 是指令 %s', (line, command) => {
    expect(parseCommand(line)).toBe(command);
  });

  it.each([
    '/compact x',
    '/compact 重点记住旅行计划',
    '/clearx',
    'x /clear',
    '/ clear',
    '/exit',
    '/start',
    '',
    '   ',
    'clear',
  ])('%j 不是指令', (line) => {
    expect(parseCommand(line)).toBeUndefined();
  });
});
