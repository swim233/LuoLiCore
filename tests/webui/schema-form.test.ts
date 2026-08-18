import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SchemaForm from '../../packages/webui/src/ui/SchemaForm.vue';

/**
 * 「只看非默认值」筛选（docs/09 §3.13）。
 *
 * 它回答的是「这个部署到底改过什么」—— 实测一个真实部署 243 个叶子里只有 21 个偏离默认值，
 * 而在此之前界面上没有任何地方能答出这一条（「原始 YAML」给的是**覆盖层**不是差异集：
 * 专用面板保存时整组写回，`config_kv` 里大半行的值与默认值相同）。
 *
 * 这里用一份**手搭的最小 schema**，刻意复刻两个真实形态：
 * - `$ref` 的兄弟位置带 `default`（zodToJsonSchema 对复用的 zod 实例就是这么发的）。
 *   跟着 `$ref` 走再读 default，判据会拿被指向那个键的默认值去比 —— 于是明明没改的项被标成「非默认」。
 * - 叶子没有 `default`：判不出来就不标，而不是当成"改过"。
 */
const SCHEMA = {
  $ref: '#/definitions/Root',
  definitions: {
    Role: { type: 'string', enum: ['blocked', 'limited', 'trusted', 'owner'], default: 'blocked' },
    Root: {
      type: 'object',
      properties: {
        logs: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['debug', 'info', 'warn'], default: 'info', description: '日志级别' },
            retentionDays: { type: 'integer', default: 30, description: '保留天数' },
          },
        },
        memory: {
          type: 'object',
          properties: {
            // `default` 在 `$ref` 的兄弟位置：真值是 trusted，被指向的那个节点写着 blocked。
            pubWriteMinRole: { $ref: '#/definitions/Role', default: 'trusted', description: '公共记忆写入的最低角色' },
            dir: { type: 'string', description: '记忆目录' },
          },
        },
      },
    },
  },
} as const;

const mountForm = (value: Record<string, unknown>) => mount(SchemaForm, {
  props: { schema: SCHEMA as unknown as Record<string, unknown>, value, hotReloadable: [], unimplemented: [], saving: false },
  attachTo: document.body,
});

describe('SchemaForm 的「只看非默认值」', () => {
  it('值等于默认值时不算非默认，$ref 的兄弟 default 也认得出来', async () => {
    const wrapper = mountForm({ logs: { level: 'info', retentionDays: 30 }, memory: { pubWriteMinRole: 'trusted', dir: './memory' } });
    await wrapper.vm.$nextTick();
    const vm = wrapper.vm as unknown as { nonDefaultCount: number };
    // `memory.dir` 没有 default（判不出来 → 不标），其余三项都等于各自的默认值。
    expect(vm.nonDefaultCount).toBe(0);
    wrapper.unmount();
  });

  it('筛选打开后只剩偏离默认值的那几项，分组也跟着少', async () => {
    const wrapper = mountForm({ logs: { level: 'debug', retentionDays: 30 }, memory: { pubWriteMinRole: 'trusted', dir: './memory' } });
    await wrapper.vm.$nextTick();
    const vm = wrapper.vm as unknown as { nonDefaultCount: number; nonDefaultOnly: boolean; groups: Array<{ name: string; entries: unknown[]; nonDefault: number }> };
    expect(vm.nonDefaultCount).toBe(1);
    expect(vm.groups.map((group) => group.name)).toEqual(['logs', 'memory']);
    expect(vm.groups.find((group) => group.name === 'logs')?.nonDefault).toBe(1);

    vm.nonDefaultOnly = true;
    await wrapper.vm.$nextTick();
    expect(vm.groups.map((group) => group.name)).toEqual(['logs']);
    expect(vm.groups[0]?.entries).toHaveLength(1);
    wrapper.unmount();
  });

  it('跟着 $ref 读 default 会误判：真值 trusted 而被指向的节点是 blocked', async () => {
    // 这一条锁的是 `classify` 的既有约定（raw 优先于 resolve 后的节点）。判据一旦改成跟着 $ref 走，
    // `memory.pubWriteMinRole` 会在没人动过它的时候被标成「非默认」。
    const wrapper = mountForm({ logs: { level: 'info', retentionDays: 30 }, memory: { pubWriteMinRole: 'blocked', dir: './memory' } });
    await wrapper.vm.$nextTick();
    const vm = wrapper.vm as unknown as { nonDefaultCount: number };
    expect(vm.nonDefaultCount).toBe(1);
    wrapper.unmount();
  });
});
