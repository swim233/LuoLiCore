# 04 · Agent 架构与 Provider 管理

## 1. Agent 拓扑

```
                       ┌──────────────────────────────────────┐
   Telegram turn ─────►│  main agent  (ToolLoopAgent)         │
                       │  depth=0  role=effective(user,chat)  │
                       │  instructions = 固定头部系统提示词    │
                       │  messages     = snapshot + delta      │
                       └───┬───────────────┬──────────────────┘
                           │               │ spawn_agent(tool)
                     普通工具            重任务
                           │               ▼
                           │      ┌───────────────────────────┐
                           │      │ sub agent  depth=1        │
                           │      │ 独立上下文（不继承历史）   │
                           │      │ role ≤ 父 role            │
                           │      └───┬───────────┬───────────┘
                           │          │           │ spawn_agent
                           │    ask_parent /      ▼
                           │    report_progress  sub agent depth=2
                           │          │           （depth=3 为上限，再 spawn 直接报错）
                           ▼          ▼
                    ToolRegistry   AgentBus ──► 主 agent 的 pendingAsk 队列
```

### 1.1 「日常聊天 vs 重任务」的判定

**不做前置分类器**。判定由主 Agent 自己在工具循环里完成——这是 AI SDK 工具调用的自然行为，也避免了「分类器错判导致体验割裂」。

- ASSIST.md 明确写清何时应 `spawn_agent`（见 [06 §2.2](./06-prompt-and-memory.md#22-assistmd-骨架)）：
  - 需要读/写超过 3 个文件，或需要多轮探索才能定位信息；
  - 预计工具调用 >5 次；
  - 需要长时间运行的命令（构建、爬取、批量处理）；
  - 需要与主对话不同的模型档位（例如廉价模型跑批量归纳）。
- 兜底护栏（代码层，非提示词层）：主 agent 单轮 `stopWhen: isStepCount(cfg.agent.main.maxSteps)`（默认 12）。触及上限时强制收尾并提示「任务较重，建议拆分或让我派发子任务」。

> AI SDK v7 同时提供 `isStepCount` 与同义的 `stepCountIs`；本项目实现统一使用 `stepCountIs`。
- **主 Agent 永远负责最终对话**：subagent 的返回值只是素材，主 Agent 必须自己组织回复（D 需求原文：「主模型根据结果进行对话」）。因此 `spawn_agent` 工具的 `toModelOutput` 只回灌摘要，且 ASSIST.md 禁止直接把子 agent 输出原样转发。

---

## 2. 主 Agent 装配

```ts
import { ToolLoopAgent, isStepCount, hasToolCall, pruneMessages } from 'ai';

export async function buildMainAgent(t: TurnCtx, deps: Deps): Promise<ToolLoopAgent> {
  const role   = t.effectiveRole;
  const tools  = await deps.tools.forRole(role, { turn: t, agentKind: 'main' });
  const prompt = await deps.prompt.build(t);          // → 见 06 文档，返回固定头部字符串

  return new ToolLoopAgent({
    model: deps.registry.resolve('main'),            // 别名 → 具体模型（含 fallback 包装）
    instructions: prompt,                            // ★ 固定头部，永不裁剪
    tools,
    toolChoice: 'auto',
    stopWhen: [
      isStepCount(cfg.agent.main.maxSteps),
      hasToolCall('finalize'),                       // 可选的显式收尾工具（默认不启用）
    ],
    // 可观测性：开启完整请求/响应捕获；是否落正文由 logs.captureBodies 决定。
    include: { requestMessages: true, requestBody: true, responseBody: true },

    prepareStep: async ({ stepNumber, messages, model, steps }) => {
      const patch: PrepareStepResult = {};

      // (a) 硬天花板：仅本次调用的临时裁剪（见 02 §5.4）
      const cap = deps.registry.info(model).contextWindow * cfg.context.hardCapRatio;
      if (deps.tokens.estimate(messages) > cap) {
        patch.messages = pruneMessages(messages, {
          reasoning: 'all',
          toolCalls: 'before-last-3-messages',
          empty: 'remove',
        });
        deps.log.event('context.hardcap', { turnId: t.turnId, stepNumber });
      }

      // (b) 每 step 重算工具白名单（Skill 载入、MCP 上线、审批结果都会改变它）
      patch.activeTools = await deps.tools.activeNames(role, t, stepNumber);

      // (c) 模型档位切换：模型可用 set_model 工具请求，或按规则自动降档
      const pinned = t.runtime.modelAliasOverride;
      if (pinned) patch.model = deps.registry.resolve(pinned);
      else if (stepNumber >= cfg.agent.main.downgradeAfterStep)
        patch.model = deps.registry.resolve('low');   // 长循环自动降费用

      // (d) 配额：预算耗尽则强制收尾
      if (!(await deps.quota.canSpend(t, cfg.quota.minReserveUsd))) {
        patch.toolChoice = 'none';
        patch.activeTools = [];
      }
      return patch;
    },

    // 生命周期回调 → 独立日志（见 10 文档）
    onStart:            e => deps.log.agentStart(t, e),
    onStepStart:        e => deps.log.stepStart(t, e),
    onToolExecutionStart: e => deps.log.toolStart(t, e),
    onToolExecutionEnd:   e => deps.log.toolEnd(t, e),
    onStepEnd:          e => (deps.ledger.record(t, e.usage, e.model), deps.log.stepEnd(t, e)),
    onEnd:              e => deps.log.agentEnd(t, e),
  });
}
```

调用：

```ts
const agent = await buildMainAgent(t, deps);
const res = await agent.stream({
  messages: [...t.snapshot.messages, ...toModelMessages(t.delta)],
  abortSignal: t.abortSignal,
});
for await (const chunk of res.textStream) out.push(chunk);   // → Telegram 流式输出
```

> `instructions` 与 `messages` 分离，正好实现需求中「头部消息固定为系统提示词，中间为动态上下文」。**不要**把系统提示词塞进 `messages[0]`，否则会被裁剪逻辑与 provider 缓存策略误伤。

### 2.1 Prompt 缓存

- Anthropic：在 `instructions` 的最后一个稳定块后打 `cache_control: {type:'ephemeral'}`（通过 `providerOptions.anthropic`）。稳定块 = 内核指令 + CHARACTER + ASSIST + PUBMEMORY + PRIMEMORY；**易变的运行时环境块放在稳定块之后**，不参与缓存 key。
- OpenAI：自动前缀缓存，只需保证前缀稳定（同上）。
- 每次记账时把 `cache_read_tokens` / `cache_write_tokens` 单独入 `usage_ledger`，并按 `models.price_cache_*` 单独计价。
- 若 `PUBMEMORY`/`PRIMEMORY` 被写入，缓存自然失效 —— 这是可接受的；但**记忆写入工具必须在轮末批量落盘**，避免一轮内多次写导致缓存反复失效。

---

## 3. Subagent

### 3.1 定义方式

Subagent 定义为**配置数据**（`config.agents[]` + WebUI 可编辑；plugin 也可注册），不是代码：

```yaml
agents:
  - name: researcher
    description: 在聊天记录/文件/网络中检索资料并给出带引用的结论
    modelAlias: low
    maxSteps: 20
    tools: [read_file, list_dir, grep, glob, search_messages, read_messages, web_fetch, web_search]
    instructions: |
      你是检索型子 agent。目标：用尽可能少的 token 找到确定答案。
      产出格式：
      ## 结论
      ## 证据（每条附 file:line 或 message id）
      ## 不确定项
    resultMaxChars: 4000

  - name: coder
    description: 在工作目录内完成多文件读写与脚本执行类任务
    modelAlias: high
    maxSteps: 30
    tools: [read_file, write_file, edit_file, list_dir, grep, glob, bash, python]
    minRole: trusted            # 低于此角色的用户不可派发该 agent
    instructions: |
      ...

  - name: summarizer
    description: 把大段文本压缩为结构化摘要
    modelAlias: low
    maxSteps: 3
    tools: []
```

### 3.2 `spawn_agent` 工具

```ts
export const spawnAgent = (t: TurnCtx, deps: Deps, parent: AgentRun) => tool({
  description:
    '把一个较重的、可独立完成的任务派发给子 agent。子 agent 有独立上下文，' +
    '只返回结果摘要。适用于：多文件探索、批量处理、长时间命令、需要不同模型档位的工作。',
  inputSchema: z.object({
    agent: z.string().describe('子 agent 名称，见系统提示词中的可用子 agent 列表'),
    task: z.string().min(10).describe('完整、自包含的任务描述。子 agent 看不到当前对话历史'),
    context: z.string().optional().describe('必要的背景资料（会原样注入子 agent 的首条消息）'),
    modelAlias: z.enum(['high','low','main','vision']).optional().describe('覆盖默认模型档位'),
    label: z.string().optional().describe('展示给用户的任务标题'),
  }),

  execute: async function* ({ agent, task, context, modelAlias, label }, { abortSignal }) {
    const def = deps.agents.get(agent);
    if (!def) return { ok: false, error: `未知子 agent: ${agent}` };

    // —— 权限与深度校验（fail-closed）
    if (parent.depth + 1 > cfg.agent.maxDepth) return { ok:false, error:'已达子 agent 深度上限' };
    const role = minRole(parent.effectiveRole, def.minRole ?? 'limited');
    if (roleRank(role) < roleRank(def.minRole ?? 'limited'))
      return { ok:false, error:'当前用户权限不足以派发该子 agent' };
    if (deps.bus.wouldCycle(parent.id, agent))
      return { ok:false, error:'检测到子 agent 环路' };

    const run = await deps.runs.create({ turnId: t.turnId, parentRunId: parent.id,
      depth: parent.depth + 1, kind:'sub', agentName: agent,
      modelAlias: modelAlias ?? def.modelAlias, effectiveRole: role, taskInput: task });

    const task$ = await deps.tasks.create({ turnId: t.turnId, agentRunId: run.id,
      chatId: t.chatId, userId: t.initiatorUserId, title: label ?? def.name });

    yield { status: 'started', taskId: task$.id };          // → 占位消息（08 §6）

    const sub = new ToolLoopAgent({
      model: deps.registry.resolve(modelAlias ?? def.modelAlias),
      instructions: deps.prompt.buildSub(def, { role, workspace: t.workspace }),
      tools: await deps.tools.forRole(role, { turn: t, agentKind:'sub', allow: def.tools, run }),
      stopWhen: [isStepCount(def.maxSteps)],
      prepareStep: subPrepareStep(run, deps),
      onStepEnd: e => { deps.ledger.record(t, e.usage, e.model, run.id);
                        deps.log.stepEnd(t, e, run.id); },
    });

    const stream = await sub.stream({
      messages: [{ role:'user', content: context ? `${task}\n\n---\n参考资料:\n${context}` : task }],
      abortSignal,
    });

    // 中间进度：把子 agent 的 progress 事件与 step 摘要 yield 出去
    for await (const ev of deps.bus.progressOf(run.id, stream)) yield ev;

    const final = await stream.finalText;
    const summary = truncate(final, def.resultMaxChars ?? 4000);
    await deps.runs.finish(run.id, { state:'done', resultSummary: summary,
      resultFullRef: await deps.blobs.put(run.id, final) });
    await deps.tasks.finish(task$.id, { state:'done', resultSummary: summary });

    return { ok: true, agent, taskId: task$.id, result: summary,
             truncated: final.length > summary.length,
             fullRef: `agentresult://${run.id}` };
  },

  // 主 agent 上下文里只保留摘要，避免子 agent 的 token 泄回主上下文
  toModelOutput: ({ output }) => ({
    type: 'text',
    value: output.ok
      ? `[子 agent ${output.agent} 完成]\n${output.result}` +
        (output.truncated ? `\n(结果被截断，可用 read_agent_result 工具读取全文: ${output.fullRef})` : '')
      : `[子 agent 失败] ${output.error}`,
  }),
});
```

### 3.3 Subagent 的隔离保证

| 维度 | 规则 |
|---|---|
| 上下文 | 全新窗口，**不含**主对话历史；只有 `task` + `context` |
| 权限 | `role = min(父 role, def.minRole)` —— **永不提权** |
| 工具 | `def.tools` 与角色白名单的交集；`spawn_agent` 仅在 `depth < maxDepth` 时提供 |
| 记忆 | 子 agent **不注入** PUBMEMORY/PRIMEMORY（除非 `def.injectMemory: true`，默认 false）；`memory_write` 不提供给子 agent |
| 工作目录 | 与主 agent 相同的 `data/workspace/<chatId>`（便于交付产物） |
| 输出 | 只有返回值进主上下文；子 agent 的完整 transcript 落 `agent_runs.result_full_ref` 与日志 |
| 配额 | 计入同一个 turn 的 `cost_usd`，共享 turn 级预算上限 |
| 取消 | 父 turn 的 `abortSignal` 级联，子 agent 立即中止 |

---

## 4. Agent 间通信

AI SDK 的 subagent 是**单向**的（父调子 → 子返回）。D13 要求双向，因此自建 `AgentBus`。

### 4.1 消息类型

| kind | 方向 | 语义 | 阻塞 |
|---|---|---|---|
| `ask` | 子 → 父 | 子 agent 需要澄清/决策才能继续 | **是**（子侧阻塞等 answer） |
| `answer` | 父 → 子 | 对 ask 的回复 | — |
| `progress` | 子 → 父 | 进度上报（转 Telegram 进度编辑 + SSE） | 否 |
| `result` | 子 → 父 | 最终结果（即工具返回值，也记一条便于审计） | 否 |
| `error` | 子 → 父 | 失败通知 | 否 |

### 4.2 子 agent 侧工具

```ts
ask_parent: tool({
  description: '当缺少必要信息、或需要上级确认方向时向上级 agent 提问。会阻塞直到得到答复或超时。',
  inputSchema: z.object({
    question: z.string(),
    options: z.array(z.string()).optional().describe('若为选择题，给出候选项'),
    urgency: z.enum(['normal','blocking']).default('blocking'),
  }),
  execute: async ({ question, options }, { abortSignal }) => {
    const msg = await bus.ask(run.id, run.parentRunId!, { question, options });
    const ans = await bus.waitAnswer(msg.id, cfg.agent.askTimeoutMs, abortSignal); // 默认 120s
    return ans ?? { ok:false, error:'上级未在时限内答复，请基于当前信息自行决策并说明假设' };
  },
}),

report_progress: tool({
  description: '上报进度。会更新用户可见的进度消息。不要频繁调用（建议每完成一个阶段一次）。',
  inputSchema: z.object({
    phase: z.string(), done: z.number().int().optional(),
    total: z.number().int().optional(), note: z.string().optional(),
  }),
  execute: async (p) => { await bus.progress(run.id, p); return { ok: true }; },
}),
```

### 4.3 父 agent 侧如何应答 `ask`

父 agent 正处在 `spawn_agent` 的 `execute` 里（同一个 JS 事件循环），不可能「在工具执行中途再跑一次模型 step」。因此 `ask` 的应答策略按顺序尝试：

1. **规则应答**：若 `options` 非空且 ASSIST.md 预设了默认选择策略（如「不确定时选第一项并声明假设」），Bus 直接按规则应答，记 `answer.source='rule'`。
2. **独立仲裁调用**（默认启用，`agent.askArbiter: true`）：Bus 用 `low` 档模型发起一次**独立的、无工具的**小调用，输入 = 父 agent 的系统提示词摘要 + 主对话最近 N 条 + 子 agent 的问题，输出 = 答复文本。这既不打断父 loop，也让答复具备主对话上下文。记 `answer.source='arbiter'`。
3. **转人工**（`urgency='blocking'` 且 `agent.askEscalateToUser: true`，默认 false）：在 Telegram 发一条带 inline 选项的消息问用户，等待 `askTimeoutMs`。记 `answer.source='user'`。
4. **超时**：返回 `{ok:false}`，子 agent 按提示词自行决策并声明假设。

所有 `ask/answer` 都落 `agent_messages` 表并进日志（`kind='agent.ask'` / `'agent.answer'`）。

### 4.4 护栏

| 护栏 | 默认 | 说明 |
|---|---|---|
| `agent.maxDepth` | 3 | `depth > maxDepth` 时 `spawn_agent` 不注册 |
| `agent.maxConcurrentSubagents` | 3 | 同 turn 在途子 agent 上限；超出排队 |
| `agent.maxSubagentsPerTurn` | 10 | 同 turn 累计派发上限（防无限派发） |
| `agent.askTimeoutMs` | 120000 | ask 阻塞超时 |
| `agent.maxAsksPerRun` | 5 | 单个子 agent 的提问次数上限，超出直接返回超时错误 |
| 环路检测 | — | `wouldCycle(parentId, agentName)`：沿 `parent_run_id` 链回溯，同名 agent 出现 ≥2 次即拒绝 |
| `agent.progressThrottleMs` | 3000 | progress 事件到 Telegram 编辑的最小间隔 |

---

## 5. Provider 与模型注册表

### 5.1 构建流程

```ts
// 启动时 + 每次 providers/models/model_aliases 变更时重建（热更新）
export async function buildRegistry(db: Db, secrets: Secrets) {
  const provs = await db.providers.enabled();

  // 1) 每个 provider 行 → AI SDK provider 实例
  const instances: Record<string, ProviderV3> = {};
  for (const p of provs) {
    const apiKey = secrets.decrypt(p.api_key_enc);
    instances[p.name] = ({
      anthropic:  () => createAnthropic({ apiKey, baseURL: p.base_url ?? undefined,
                                          headers: json(p.headers_json) }),
      openai:     () => createOpenAI({ apiKey, baseURL: p.base_url ?? undefined }),
      google:     () => createGoogleGenerativeAI({ apiKey }),
      'openai-compatible': () => createOpenAICompatible({ name: p.name, apiKey,
                                          baseURL: p.base_url!, headers: json(p.headers_json) }),
      gateway:    () => createGateway({ apiKey }),
    }[p.kind]!)();
  }

  // 2) 底座 registry：'providerName:modelId' 寻址
  const base = createProviderRegistry(instances);           // separator ':'

  // 3) 别名层：alias → 有序 fallback 链，逐个包装重试/记账中间件
  const aliases = await db.modelAliases.all();
  const languageModels: Record<string, LanguageModelV3> = {};
  for (const a of aliases) {
    const chain = json<string[]>(a.model_ids_json)
      .map(id => db.models.byId(id))
      .filter(m => m && m.enabled)
      .map(m => wrapLanguageModel({
        model: base.languageModel(`${provName(m.provider_id)}:${m.model_id}`),
        middleware: [
          defaultSettingsMiddleware({ settings: json(a.settings_json) ?? {} }),
          usageMiddleware(m),        // 自建：把 usage×定价 写 usage_ledger（10 §4）
          loggingMiddleware(m),      // 自建：请求/响应落 JSONL（10 §3）
        ],
      }));
    languageModels[a.alias] = fallbackModel(chain, cfg.provider);   // 自建 fallback 包装
  }

  return customProvider({ languageModels, fallbackProvider: base });
}

// 使用
registry.languageModel('main')          // 别名
registry.languageModel('anthropic-main:claude-opus-5')   // 直指（WebUI 测试用）
```

### 5.2 内建别名语义

| 别名 | 用途 | 建议档位 |
|---|---|---|
| `main` | 主 Agent 默认 | 中高（对话质量优先） |
| `high` | 复杂推理、代码类子 agent | 最强模型 |
| `low` | 批量归纳、摘要、仲裁应答、记忆压缩 | 最便宜可用模型 |
| `vision` | 含图片的轮次（`prepareStep` 自动切换） | 支持 vision 的模型 |
| `title` | 生成任务标题/会话摘要 | 最便宜 |
| `embed` | （预留）向量检索 | embedding 模型 |

规则：
- 别名缺失时按 `main → high → low` 顺序回退；`main` 缺失则**拒绝启动**并在 WebUI 显红。
- 轮次包含图片且当前模型 `capabilities.vision=false` → `prepareStep` 自动切 `vision`；若 `vision` 未配置 → 图片降级为 `[图片: <caption>]` 文本占位并在回复末尾提示。
- 模型可用 `set_model` 工具（`minRole=trusted`）为**当轮**指定别名，写入 `turn.runtime.modelAliasOverride`；不跨轮持久。
- 用户可用 `/model <alias>` 为**当前会话**固定别名（`minRole=trusted`，存 `config_kv` 的 `perChat.modelAlias.<key>`）。

### 5.3 Fallback 与重试

```ts
fallbackModel(chain, cfg) 语义：
  for (const m of chain) {
    for (let i = 0; i <= cfg.maxRetries; i++) {
      try { return await m.doGenerate/doStream(...) }
      catch (e) {
        if (isRetriable(e)) { await sleep(backoff(i, e.retryAfter)); continue }  // 429/5xx/网络
        if (isModelFatal(e)) break                                              // 400/上下文超限/内容策略
        throw e                                                                 // 认证等 → 直接抛
      }
    }
    log.event('provider.fallback', { from: m.modelId, next: chain[idx+1]?.modelId })
  }
  throw new AllProvidersFailed(chain)
```

- `backoff(i, retryAfter) = retryAfter ?? min(1000 * 2^i * (1±0.2), 30000)`
- **流式已输出部分内容后失败**：不切模型（避免重复内容），直接把已有内容作为最终回复 + 追加「(生成中断)」，turn 记 `failed` 但 delta **照常提交**（用户已经看到内容了，上下文必须与用户所见一致）。这是 §1 「delta 不提交」规则的唯一例外，必须在实现中显式处理。
- 健康检查：每 `provider.healthCheckCron`（默认 10 分钟）对启用的 provider 发一次 1-token 探测；连续失败 3 次标 `health_state='down'`，WebUI 显示并从 fallback 链临时跳过（`down` 状态 30 分钟后自动重试）。

### 5.4 密钥管理

- 明文 API Key **只存在于内存**。落库前 `AES-256-GCM(key=SHA256(LUOLI_MASTER_KEY), iv=随机12B)`，格式 `v1.<iv_b64>.<ct_b64>.<tag_b64>`。
- `LUOLI_MASTER_KEY` 只来自环境变量；缺失时 provider 相关功能禁用并在 WebUI 明确提示（不静默降级为明文）。
- API 返回 provider 时**永远只返回 `api_key_hint`**；前端字段为「写入型」（留空 = 不修改）。
- 日志脱敏：全局正则移除 `sk-[A-Za-z0-9_\-]{16,}`、`Bearer\s+\S+`、bot token 形态 `\d{8,10}:[A-Za-z0-9_-]{35}`。
- WebUI「测试连接」按钮：用输入框中的（或已存的）key 发一次最小调用，只返回成功/错误类型，**不回显 key**。
  「最小调用」= 按 kind 请求上游的模型目录接口（`openai`/`openai-compatible` → `{baseUrl}/models`；
  `anthropic` → `{baseUrl}/models` + `x-api-key` + `anthropic-version`；`google` → `{baseUrl}/models` + `x-goog-api-key`），
  15s 超时。选它而不是发一次 1-token 补全，是因为它不花钱、不受模型是否配置影响，且同一次响应正好就是「拉取模型列表」要的数据。
  错误按 `unauthorized / not_found / upstream_error / timeout / network / invalid_response / missing_base_url / no_master_key` 归类，
  上游响应体只截前 300 字符做摘要（**先过一遍日志脱敏正则**，网关会把请求头回显进错误体）。健康状态写入规则见 [09 §4](./09-webui.md#4-rest-api)。

### 5.5 定价与 token 计费

- `models.price_*` 单位 USD / 1M tokens，由 owner 在 WebUI 维护（不自动抓取，避免依赖外部数据源）。
- `cost = (in*price_in + out*price_out + cache_read*price_cache_read + cache_write*price_cache_write) / 1e6`
- 缺定价的模型：`cost=0` 但记 `usage_ledger.error_kind='no_pricing'`，WebUI 在用量页显式告警（否则配额会被绕过）。
- 若 `quota.requirePricing = true`（默认 `true`），**无定价的模型不允许被非 owner 使用**（fail-closed，防止配额形同虚设）。

---

## 6. WorkflowAgent / HarnessAgent 的取舍

AI SDK v7 还提供 `WorkflowAgent`（确定性编排）与 `HarnessAgent`（包装 Claude Code / Codex 等现成 harness）。本项目：

- **不使用 `WorkflowAgent`**：本系统的编排逻辑（turn 生命周期、上下文提交）在我们自己的 `TurnRunner` 里，语义更强；把它塞进 WorkflowAgent 反而丢失对 commit/rebase 的控制。
- **`HarnessAgent` 列为可选扩展**：可作为一个内置 subagent 定义（`agents[].kind: 'harness'`），把「让 Claude Code 在 workspace 里改代码」变成一个子 agent。**第一版不实现**，记入 [14](./14-open-questions.md)。设计上只需 `spawn_agent` 的 `execute` 分支到 `HarnessAgent`，其余（权限、记账、进度、取消）复用现有管线。

---

Sources（AI SDK 调研）：
- [Agents: Overview](https://ai-sdk.dev/docs/agents/overview)
- [Agents: Building Agents](https://ai-sdk.dev/docs/agents/building-agents)
- [Agents: Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- [Agents: Subagents](https://ai-sdk.dev/docs/agents/subagents)
- [AI SDK Core: Provider & Model Management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management)
- [AI SDK Core: Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [AI SDK Core: ToolLoopAgent (reference)](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
