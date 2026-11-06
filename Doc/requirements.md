# dsh-mcp-mgr 需求文档

> 状态：**工作区后端池重构已实现并通过本地回归**；当前 DSH host 尚未重启验证。旧实现记录保留为历史。

## 背景

dsh 目前的 MCP 接入只有一条路径：`@deepseek-ai/dsh-mcp-client` 插件，一个实例 = 一个 MCP server，配置在 cordis patch 层（profile 级 `cordis.patch.yml` / home 级 / `--patch`），且该插件不在默认 bundle 里，需手动安装 + 手写 yml。没有任何项目/工作区级配置机制，也没有 CLI / GUI 管理入口（已验证，证据见会话记录）。

## 目标

- **插件组 1（核心，host 插件）**：工作区目录下 `.dsh/dshmm/mcp.json`（类 Claude/Codex 的 `mcpServers` 格式），dsh 载入工作区时自动发现并动态注册其中所有 MCP server；文件变更热同步；工作区删除时卸载。
- **插件组 2（web UI 插件，仅 web profile）**：在 dsh 设置页中展示与管理由组 1 注册的 MCP：列表、状态、增删改、来源工作区标注、冲突提示。

## 历史实现状态（2026-08-15，非池化验证）

```
packages/dsh-mcp-mgr/      组1 host 插件（已实现 + 验证）
  src/{index,parse,mounts,discovery,profile,watch,version,types}.ts
  lib/typert.{host,remote-client}.js    Remote 产物（mcpMgr: snapshot/apply/remove）
packages/dsh-mcp-mgr-ui/   组2 client 插件（已实现 + 构建）
  src/{index.ts, client/{index.ts,McpPage.tsx,locales.ts}}
  lib/client.js            浏览器 bundle（__ModuleLoader__ closure，145KB）
packages/vendor-typert-protocol/   vendored protocol 源码（S1 约束）
packages/{platform,tsdown.client}.ts   client 构建基础设施（从 dsh 复刻）
gen.mjs / verify.mjs / e2e/   生成 + 单测 + 真实 MCP server 端到端
```

- **验证覆盖**：解析/${VAR}展开/拒绝路径；按 agent 挂载生命周期（`verify.mjs`，假 host：懒挂载、等待预算与中止、空闲停止、配置变更、冲突、挂载失败、并发；工作区解析含 headless/symlink/大小写）；Remote 产物 strict codec + 真实 Typert registry 挂载；**真实 mcp-client + 真实 stdio MCP server 端到端**（`e2e/e2e.mjs`：双工作区隔离、首个组装含工具、子 agent、空闲停止、mcp.json 变更、进程退出）
- **已知未验证**：真实 dsh web profile 中的 UI 渲染与 roster 加载仍需人工确认；真实 workspaceRegistry 下的按 agent 工作区解析（e2e 使用假 registry）
- **已验证**：本地 source profile 在隔离 `DSH_HOME` 下完成 add、bundle reconciliation、remove；源码 CLI 与本仓库 checkout 不要求固定目录
- 构建命令（均从仓库根目录执行）：`pnpm run check`（build + verify）；生成器和回归使用正式 npm 包，不依赖 deepseek-harness 源码路径

## 总体设计

> 已批准的池化契约取代 [ADR-0001](<adr/0001-agent-scoped-lazy-workspace-mcp-mounts.md>) 中每 agent 独立后端、首轮懒启动与空闲停止的规则；ADR 保留为历史。agent 作用域可见性与工作区边界不变。

```
mcp.json → 发现、解析、watch / 周期重扫
    ▼
agent/created（创建 / 恢复）；首个 turn 兜底
    ▼
后端池：工作区规范路径 + server ID → 一个后端、一个启动 promise
    │ scope: 'agent' → 改为每 agent 独立后端
    ▼
每 agent 的 tools / resources / server instructions 绑定
```

共享后端跨 idle 和最后一个 agent 销毁保持运行；隔离后端随所属 agent 销毁。会话启动等待受 `agentMountWaitMs` 限制，abort 只结束等待，不取消共享启动。首次冷启动仍存在，共享 server 的可变状态也会共享。

## 关键决策（已定）

| 决策 | 结论 |
|---|---|
| 工作区语义 | **后端默认按工作区共享，可见性按 agent 隔离**：agent 仅绑定 session `cwd` realpath 精确匹配的登记工作区；无匹配则不绑定。headless 仅匹配 host cwd；Web registry 未就绪时等待后续 turn 兜底 |
| 后端身份 | 单个 host 内以 **工作区规范路径 + server ID** 唯一；不同工作区可使用同名 `graphiti`，保留各自配置/记忆命名空间，无需全局改名 |
| 隔离选项 | mcp.json `scope: 'workspace'`（缺省）共享；`scope: 'agent'` 每 agent 独立后端；两者工具/resources/server instructions 均按 agent 注册 |
| 启动与等待 | `agent/created` 在会话创建/恢复时启动，首个 turn 兜底；同一池项并发加入共用启动 promise。会话启动及首轮兜底等待受 `agentMountWaitMs` 限制；超时/abort 结束等待而不取消共享启动 |
| 生命周期 | 共享后端跨 idle / 最后 agent 销毁保持运行；server 禁用/移除、传输配置变更、工作区移除、管理器卸载或 host 关闭时停止。scope 变更替换后端；agent 隔离后端随所属 agent 销毁，无 idle 重启 |
| 配置兼容 | `agentIdleTimeoutMs` 保留但已弃用且忽略；`excludeTools` 仅更新绑定，不重启后端 |
| 严格模式 | **移除**（含 `activeWorkspace`、UI 开关与 localStorage 回放） |
| 按 preset 屏蔽 | **零耦合**：本插件不含 preset 逻辑、不发事件，同一工作区所有 agent 获得相同 server；preset 级屏蔽由独立插件在调用时处理（E1）。被屏蔽 preset（如 orchestrator）仍可见工作区 MCP 工具且进程会启动。见 ADR-0001 |
| 同名冲突 | 工作区 server 与 profile 级 server 同名：标 conflict，不挂载，UI 展示 |
| 通道路线 | **通道①（自建 Typert Remote）可行**（S1 已验证，代价：vendor protocol 源码 + workspace 布局）；② settings 通道仍可作轻量备选 |
| 格式映射 | `mcpServers` → mcp-client config 直译；支持 `${VAR}` env 展开；Claude `type: http` → `transport: streamable-http` |
| stdio server cwd | **必须显式传工作区根路径**（`cwd:''` 会落到 host 进程目录，S3） |

## 池化验收条件（本地回归覆盖）

- **AC1 身份与复用**：同一规范工作区 + server ID 的多个 agent/子 agent（含并发创建）仅启动一个共享后端；不同工作区同名 server 独立，无配置重命名。
- **AC2 启动与就绪**：创建/恢复触发启动，已有 agent / 延迟发现通过首轮兜底；等待有界，任一等待者超时/abort 不取消共享启动、不影响其他等待者，后台就绪后可在后续组装使用。
- **AC3 生命周期**：idle 与最后一个 agent 销毁不停止共享后端；server 禁用/移除、传输配置变更、工作区移除及管理器/host 退出会清理后端和绑定，替换不产生重叠进程。
- **AC4 可选隔离**：`scope: 'agent'` 启动独立后端，随所属 agent 销毁且不因 idle 重启；scope 变更替换相应后端；`agentIdleTimeoutMs` 不改变上述行为。
- **AC5 绑定与隔离**：工具、resources、server instructions 只对所属工作区的已绑定 agent 可见；`excludeTools` 更新绑定且进程不重启；共享状态风险与首次冷启动限制在用户文档中说明。
- **AC6 故障与并发**：验证启动失败/重试、重连、配置替换、调用中 agent 销毁与并发调用；不得将共享连接等同于 server 状态可安全并发使用。

## 机制限制（dsh 现状约束）

1. **工具可按 agent 作用域注册，但自有作用域工具不受 `restrict` 约束**（0.2.0-rc.2 `core/tools` `view()`/`restrict()`）：按 agent 挂载可实现工作区隔离，preset 级 deny 无法隐藏这些工具，只能由 E1 guard 在调用时拒绝 —— 详见 ADR-0001。（原"工具是 host 全局的"结论已不成立。）
2. **`workspaceRegistry` 无事件**：创建/删除工作区不发出任何事件，组 1 需自建同步兜底（watch 各工作区目录 + 周期重扫）。
3. **mcp-client 不在 base bundle**：组 1 自行声明 `@deepseek-ai/dsh-mcp-client` 依赖即可，用户无需单独安装。
4. **serverName 仅需在单个 mcp.json 内唯一**（ADR-0001）：mcp-client 按 scope 保留名称，不同工作区同名互不冲突；仅与 profile 级（全局）server 同名时标 conflict 且不挂载（防止自有工具静默遮蔽全局工具）。
5. **headless 无 workspaceRegistry**：只能按 cwd 发现（agent cwd 须 realpath 等于 host cwd），多项目并存场景（如 host 进程内）不支持。
6. **preset 卡片看不到工作区工具**（待定后续）：preset 工具访问设置卡片按全局注册表 + preset scope 列工具，agent 自有的工作区 MCP 工具不出现、无法勾选；需另找通用、零耦合、免手改的发现机制，见 ADR-0001。

## 待验证路线（spike 清单）

- [x] **S1 树外 Typert 生成**：✅ 已验证可行（`spike/` 下最小插件包 `dsh-spike-remote`，脱离仓库 tsdown+`DSH_BUILD_FACE` 接线，直接调 `WorkspaceTypertGenerator` 生成 `typert.host.js` + `typert.remote-client.js`，并通过真实 Typert registry 挂载 + codec 收发验证）。**两个硬约束**：
  1. analyzer 的 `isTypeMetaSymbol` 只识别 workspace 内 registration 的符号 → `@Remote`/`TypertRemoteService` 必须来自本仓库 packages/ 下的包 → **插件仓库必须 vendor 一份 `@deepseek-ai/dsh-typert-protocol` 源码**（复制 src 即可，协议包无额外运行时依赖）
  2. 插件仓库根需 `tsconfig.host.json`（workspace root marker）+ `packages/<pkg>/` 布局（analyzer 要求包在 `root/packages` 内）
- [x] **S2 `dsh.client` roster**：✅ 加载链路确认。扫描源是 `ctx.loader.entries()`（cordis 配置树），包经 profile 目录的 node_modules 解析（`ctx.baseUrl` 锚点），声明 `dsh.client` + exports `./client` 即进入 `window.__DSH_BOOT__`，浏览器经 `/plugins/<id>/client.js` 拉取。树外 client 插件 = profile patch 加一行 `- id: xxx / name: <pkg>` + `dsh plugin add` 安装
- [x] **S3 `mcp-client` cwd 语义**：✅ `config.cwd: ''` 与缺省等价，MCP SDK 原样传给 Node `spawn`，子进程继承 **host 进程** cwd（实测）→ mcp.json 的 stdio server 必须显式传工作区根路径
- [ ] **S4 同步触发点**：设计确认项（非 spike）：watch + 周期重扫即可，settings 通道写入路径在组 1 实现时确定（chokidar 先例已确认）

## 已实现（2026-08-15 追加）

- **非工作区来源 MCP 展示**：host 扫描 `ctx.loader.entries()` 中 mcp-client 注册（profile patch / bundle / --patch），按 fiber 状态映射 active/error/configured，跨来源 serverName 冲突标 conflict，来源文件经 `cordis.patch.yml` 内容探测（`packages/dsh-mcp-mgr/src/profile.ts`）；UI 只读展示（来源路径 + chip + 行底色区分）
- **表格 UI 调整**：来源路径自适应缩短（末一段，同名补末两段；profile 行固定末两段）+ hover 全路径；`table-layout: fixed` 列宽（服务/传输/状态/操作不再折行）；移除按钮红字 ghost
- **npm 用户安装（bundle 路线）**：`dsh-mcp-mgr` 声明 `dsh.bundle`（patch 引 host + ui 两行），ui 包作其正式 npm 依赖；通过 `dsh plugin --profile web add dsh-mcp-mgr@latest` 安装，卸载只需移除 `dsh-mcp-mgr`，由官方 profile 管理依赖与 bundle 层

## 发布、安装与验证

完整的用户操作步骤见 [`README.zh.md`](../README.zh.md) 或 [`README.md`](../README.md)。本节只记录边界：

### npm 用户

- 发布前从本仓库根目录执行 `pnpm run check`。
- UI 包和 host 包分别发布后，用户执行：

  ```powershell
  npx @deepseek-ai/dsh plugin --profile web add dsh-mcp-mgr@latest
  npx @deepseek-ai/dsh web
  ```

- 卸载执行 `npx @deepseek-ai/dsh plugin --profile web remove dsh-mcp-mgr`。

### 双源码开发者

- 两个 checkout 可以位于任意目录；只配置一次 `DSH_HARNESS_ROOT`，指向 deepseek-harness 源码根目录。
- harness 源码根目录先执行 `pnpm install`、`pnpm run build`；本仓库再执行 `pnpm install`、`pnpm run check` 和 `pnpm run profile:add` 安装当前 checkout。
- harness 源码根目录最后执行 `pnpm dsh web --no-open`。
- 清理本地 profile 执行 `pnpm run profile:remove`。
- `DSH_HARNESS_ROOT` 仅供 `profile:add` / `profile:remove` 调用 source CLI；`build`、`gen.mjs`、`verify.mjs` 不读取它。

本次验证：`pnpm run check`、`pnpm run test:e2e`，以及各套件连续五轮回归（`ALL PASS`、`E2E PASS`、`SETTLE PASS`、`POOL EDGES PASS`）。五个定向变异均被捕获并恢复。真实 stdio 测试覆盖 PID 复用、命名空间隔离、资源/指令绑定、工具变更通知、重连与握手未完成时的卸载；registry 使用测试替身。当前 DSH host 未重启，真实 Web UI 与用户 server 的实机性能仍待确认。

## 未来扩展（本期不做）

- workspaceRegistry 事件（给 dsh 提 PR，消除周期重扫）
- preset 卡片发现 agent 自有工作区工具（候选：观察 live agent 的 tools/change 并持久化已见 mcp__<server>__* 名单；经 cordis 插件注册表枚举 mcp-client fiber；DSH 宿主级特性/上游提案；未选定）
- 自有作用域工具的 preset 级隐藏（需 dsh 核心支持 restrict 覆盖自有/后注册名称，ADR-0001 H1）
- MCP Prompts 桥接（不影响本期既有 resources 与 server instructions 的 agent 作用域绑定）
- 非工作区来源 MCP 的写回管理（移除/编辑 profile patch 条目）
- CLI 管理命令（`dsh mcp` 子命令）

## 非目标

- 不改 dsh 核心/不动仓库内 api-remotes 装配（除非 S1 证明树外路线不可行）
- 不实现 MCP server 的下载/安装/认证（沿用 mcp-client 的职责边界）
