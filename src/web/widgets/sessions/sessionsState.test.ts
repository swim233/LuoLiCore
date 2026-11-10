import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../model/db';
import type { Conversation } from '../../model/types';
import {
  backToList,
  dropGone,
  pickConv,
  resetSessState,
  sessCur,
  sessState,
} from './sessionsState';

/* 会话部件在窗口和全屏之间共用的状态：选中哪个会话、窗口停在列表还是时间线 */
const conv = (id: string) => ({ id, title: id, lastAt: new Date().toISOString() }) as Conversation;

describe('会话部件的共用状态', () => {
  beforeEach(() => {
    db.reset();
    db.setConversations([conv('a'), conv('b')]);
    resetSessState();
  });

  it('点开一个会话：选中它，窗口进时间线这一层；返回只回到列表，选中的还记着', () => {
    pickConv('a');
    expect(sessState.get()).toEqual({ cur: 'a', detail: true });
    backToList();
    expect(sessState.get()).toEqual({ cur: 'a', detail: false });
    expect(sessCur()).toBe('a');
  });

  it('选中的会话还在时，数据整批换了也留着', () => {
    pickConv('b');
    db.setConversations([conv('b'), conv('c')]);
    dropGone();
    expect(sessState.get()).toEqual({ cur: 'b', detail: true });
  });

  it('选中的会话不在了：什么都不选，窗口回到列表', () => {
    pickConv('a');
    db.remove('a');
    expect(sessCur()).toBeNull();
    dropGone();
    expect(sessState.get()).toEqual({ cur: null, detail: false });
  });

  it('没选过会话时 dropGone 什么都不改', () => {
    dropGone();
    expect(sessState.get()).toEqual({ cur: null, detail: false });
  });
});
