# NOTES

## 挂载模型（ADR-0001）

- 按 agent 懒挂载：`system-prompt/assemble`（prepend）监听带 `agent` + `signal` 的 turn 组装，等待挂载；工作区内全部启用且非 conflict 的 server，无 preset 逻辑、不发任何事件
- 注册有变则以复制的上下文重跑一次组装：重跑中本监听器直接返回新的基础 assembly（不调 `next()`），外层用它覆盖当前 assembly 后再 `next()`；内层监听器只跑一次，在本插件之后 prepend 的（外层）监听器在重跑中多跑一次、输出被丢弃
- 等待预算按 agent 活动计（`agent/status` 变化即重置）：锁等待、停止、挂载与重跑共用 `agentMountWaitMs`，`signal` 中止立即返回；超时后挂载在后台继续，同一活动后续 step 只等剩余预算
- scope = `createScope(pluginCtx, agent)`，`agent.ctx.effect` 清理 + 插件卸载双重归属；同一 agent 的挂载/停止经 promise 链串行（同名 server 必须先释放再挂载，mcp-client 按 scope key 保留 serverName）
- 挂载失败：在锁内释放并等待旧句柄销毁，scope 空则销毁；下个 turn 重试；同一错误只告警一次
- 空闲：`agent/status` idle 起计时，running 清除；计时到点且 agent 仍空闲（锁内再查）才停止
- 配置变更：rescan 后对每个工作区 `configChanged`，仅停止已不在候选集中的 server；新增/修改留到下个 turn
- 工作区解析：`realpath.native(cwd)` 与登记路径（已规范化）比较，不逐个 realpath；无 registry 时仅等于 `realpath.native(process.cwd())` 才命中；Web profile 的 registry 未就绪（loader 中有 `@deepseek-ai/dsh-workspace` 条目）视为无工作区

## 状态语义

- 工作区行 status 只表示配置：`configured` / `disabled` / `conflict`（与 profile 级同名）/ `error`（条目解析失败）
- `liveAgents` = 持有该 server 挂载的 agent 数（含连接中）；`connectedAgents` = `tools.schemas(agent)` 含 `mcp__<name>__*` 的 agent 数，快照时每 agent 计算一次
- `lastError`：该 server 最近一次挂载失败；成功、server 移除或工作区移除时清除
- 刷新按钮只重新拉取快照

## 排查教训

- 改 `types.ts`（wire 字段）后必须重跑 `gen.mjs` 并**重打 UI bundle**：typert 客户端 codec 过期时，严格 codec 会静默剥离未知字段，且只影响通过 Remote 返回的数据，直接读 host 状态看不出来
- 构建顺序（均从仓库根目录执行）：`pnpm run build:host → pnpm run build:client → pnpm run verify`；端到端：`node e2e/e2e.mjs`、`node e2e/apply-remove-settle.mjs`
