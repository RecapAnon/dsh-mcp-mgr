# NOTES

## 后端池与 agent 绑定

- 本节取代 ADR-0001 的每 agent 独立后端、首轮懒启动与空闲停止规则；ADR 保留为历史。
- 本地验证：`pnpm run check`；`pnpm run test:e2e`。单测及三组真实 stdio 集成回归连续五轮通过；五个定向变异均被测试捕获。尚未重启当前 DSH host 做实机验证。
- 单个 host 的默认后端池以 `(工作区规范路径, server ID)` 为键；同名 server 可出现在不同工作区，配置和记忆命名空间独立，无需重命名；同一工作区的 agent/子 agent 共用后端及启动 promise。
- mcp.json 可设 `scope: 'agent'` 保留每 agent 后端隔离，省略或 `scope: 'workspace'` 为共享；工具、resources、server instructions 始终仅对绑定的 agent 可见，不在全局注册。
- `agent/created`（会话创建/恢复）启动并绑定；首个 turn 兜底已有 agent、延迟发现的工作区。工作区全部启用且非 conflict 的 server 均适用，无 preset 逻辑。
- 会话启动等待受 `agentMountWaitMs` 限制，首轮兜底等待也有界；超时/abort 仅结束该 agent 的等待，不取消共享启动。后台就绪后在后续组装可见；首次冷启动耗时仍在。
- 共享后端跨 idle 与最后一个 agent 销毁保持运行；仅在 server 禁用/移除、传输配置变更、工作区移除、管理器卸载或 host 关闭时停止。scope 变更替换受影响的后端；旧实例须先完成销毁，避免重叠进程。
- `scope: 'agent'` 后端随所属 agent 销毁，不因空闲重启。`agentIdleTimeoutMs` 已弃用、忽略，仅保留旧配置兼容性。
- 工具过滤（工作区）：`excludeTools` 仅改变 agent 绑定，不进入传输配置指纹，不触发后端重启；catalog 保留 server 已发现的工具供 UI 选择。
- 共享也意味着共享可变状态（如当前项目、浏览器会话）；需要隔离时使用 `scope: 'agent'`。并发调用、取消等待、重连及配置替换须覆盖回归，不能仅以进程复用断言安全。
- 工具过滤（profile）：`<profileDir>/dshmm/tools.json`（目录取 `profileContext.dir`）；每次组装时对 agent `tools.restrict({ deny })`，deny 只取全局层中匹配的名字（restrict 拒绝未知名）；集合变化才换新 restriction（先装新再撤旧），算作“有变化”触发重组装；插件卸载时撤销全部
- 工具名 = 公共名去掉 `mcp__<server>__` 前缀（server 名 ≤32，前缀不会被截断/哈希），不复刻 mcp-client 的哈希逻辑
- stdio 经 `stdio-shim` 启动：mcp-client 的 SDK（`versionNegotiation: auto`）先起一个同参数的一次性进程发 `server/discover`，答复后杀掉再起真进程，慢 server 因此启动两次；shim 对首条 `server/discover` 自答 `-32601`（SDK 转 legacy）且不启动 server，其他首条消息才用 SDK 的 cross-spawn 启动真 server 并透传 stdio；cross-spawn 解析不到则不包装
- 工作区解析：`realpath.native(cwd)` 与登记路径（已规范化）比较，不逐个 realpath；无 registry 时仅等于 `realpath.native(process.cwd())` 才命中；Web profile 的 registry 未就绪（loader 中有 `@deepseek-ai/dsh-workspace` 条目）视为无工作区

## 状态语义

- profile 行：禁用的 mcp-client 条目也列出（`disabled`，不判 conflict）；启停走 `pluginManager.setPluginEnabled(loader entry.id)`，不自己改 YAML（bundle 行不在 profile 文件里，只能写覆盖行）；改完 host 代码须重启 dsh web
- 工作区行 status 只表示配置：`configured` / `disabled` / `conflict`（与 profile 级同名）/ `error`（条目解析失败）
- `liveAgents` = 持有该 server 绑定的 agent 数（含连接中），不是后端进程数；`connectedAgents` = `tools.schemas(agent)` 含 `mcp__<name>__*` 的 agent 数，快照时每 agent 计算一次；共享后端可在两者为零时仍运行
- `lastError`：该 server 最近一次后端启动失败；成功、server 移除或工作区移除时清除
- 刷新按钮只重新拉取快照

## 排查教训

- 首轮组装等满 `agentMountWaitMs` 且无工具：先量 server 启动耗时与 era 探测（是否启动两次），不是 Cordis fiber 激活被阻塞；e2e 以 pid 文件数断言每次挂载只启动一次
- 改 `types.ts`（wire 字段）后必须重跑 `gen.mjs` 并**重打 UI bundle**：typert 客户端 codec 过期时，严格 codec 会静默剥离未知字段，且只影响通过 Remote 返回的数据，直接读 host 状态看不出来
- 构建顺序（均从仓库根目录执行）：`pnpm run build:host → pnpm run build:client → pnpm run verify`；端到端：`node e2e/e2e.mjs`、`node e2e/apply-remove-settle.mjs`
