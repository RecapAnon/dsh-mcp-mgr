# dsh-mcp-mgr

[English](README.md) | 中文

---

0.3.0 更新: 已验证适配 dsh@0.2.0-rc.2

```bash
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-mcp-mgr@0.3.0
```

---

dsh 的工作区级 MCP 管理器：从每个工作区的 `.dsh/dshmm/mcp.json` 读取 MCP server，动态注册工具，并在 Web 设置页提供管理界面。

![MCP 服务列表](Doc/assets/plugin-shot.jpg)

## 选择使用方式

| 使用者 | 入口 | 是否需要源码仓库 |
| --- | --- | --- |
| 普通用户 | npm 包 + `npx @deepseek-ai/dsh` | 不需要 deepseek-harness 或本插件源码 |
| 源码开发者 | deepseek-harness source + 本仓库 source | 见[源码开发者指南](Doc/development.zh.md) |

## 普通用户：使用 npm 包

### 安装并启动

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-mcp-mgr@latest
npx @deepseek-ai/dsh web
```

更新时重复执行安装命令即可：

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-mcp-mgr@latest
```

卸载：

```powershell
npx @deepseek-ai/dsh plugin --profile web remove dsh-mcp-mgr
```

### 工作区配置

在工作区根目录创建 `.dsh/dshmm/mcp.json`：

```json
{
  "mcpServers": {
    "my-http-server": {
      "type": "http",
      "url": "http://127.0.0.1:8090/mcp"
    },
    "my-stdio-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "<mcp-server-package>"]
    }
  }
}
```

规则：

- 缺省 `type` 按 Streamable HTTP 处理；支持 `${VAR}` 环境变量展开。
- stdio server 未指定 `cwd` 时使用工作区根目录。
- `serverName` 只需在单个 mcp.json 内唯一，不同工作区可同名；与 profile 级 mcp-client server 同名时显示 `conflict` 且不挂载。
- 后端默认按工作区共享（`"scope": "workspace"`，也可省略 `scope`）；需要隔离 server 状态时，设置 `"scope": "agent"`，每个 agent 使用独立后端。
- 设置 `"enabled": false` 可禁用条目但不删除；缺省为启用。
- 设置 `"excludeTools": ["<工具名>", ...]` 可对所有 agent 隐藏该 server 的部分工具（不注册，因此不进入提示词）。工具名为 `mcp__<serverName>__` 之后的部分，除非原名含 `[A-Za-z0-9_-]` 以外的字符，否则即 server 自己的工具名。

## 行为与限制

- 工作区工具使用 `mcp__<serverName>__<tool>` 命名。
- 单个 DSH host 内，后端池以 **工作区规范路径 + server ID** 为键。不同工作区可各自定义 `graphiti`，保留各自配置和记忆命名空间，无需全局改名；同一工作区的主 agent、子 agent 复用同一后端（包括进行中的启动）。
- 在 `agent/created`（会话创建/恢复）时开始启动；已有 agent 或工作区发现较晚时，首个 turn 兜底。session `cwd` 的 realpath 须等于已登记工作区（headless 为进程 cwd）；Web 工作区登记服务尚未就绪时不挂载，下个 turn 重试。不属于工作区的会话没有工作区工具。
- 即使共享后端，工具、resources 与 server instructions 仍按 agent 作用域注册。共享后端在空闲或最后一个 agent 销毁后仍保持运行，直到 server 禁用/移除、传输配置变更、工作区移除、管理器卸载或 host 关闭。`"scope": "agent"` 后端则归所属 agent 所有，在该 agent 销毁时停止；两种模式均不因空闲而重启。
- 共享后端也共享 server 的可变状态（如当前项目或浏览器会话）；不适用时设置 `"scope": "agent"`。首次冷启动耗时仍然存在，池化避免后续 agent 重复承担该耗时。
- 工作区 stdio server 经一个小的 `node` 启动器（`lib/types/stdio-shim.js`）启动，由它直接应答 mcp-client 的 `server/discover` 协议版本探测。否则该探测会在一个用完即弃的 server 副本上进行，慢启动的 server（如 `uv run --isolated`）每次挂载都要启动两次。因此工作区 stdio server 一律使用 2026 之前（legacy）的 MCP 握手。
- 会话启动等待受 `agentMountWaitMs` 限制，首个 turn 的兜底等待也有上限。超时或中止仅结束该 agent 的等待，不取消共享启动；仍在连接的 server 在后台继续，并在后续组装中可用。启动失败显示为最近错误。
- 组装期间挂载改变了 agent 的工具时，提示词组装重算一次；在本插件之后 prepend 的 `system-prompt/assemble` 监听器会因此多执行一次（该次输出被丢弃）。
- mcp.json 变更：移除或禁用 server 会停止其后端并撤销绑定；传输配置或 scope 变更会替换受影响的后端；`excludeTools` 变更仅更新 agent 绑定，不重启进程。
- 工作区内每个 agent 都获得该工作区全部启用且非 conflict 的 server；不按 preset 过滤。
- 兼容性：需要 `dsh-preset-tool-access` **>= 0.2.1**（更早版本的 `restrict` 遇到 agent 作用域工具名会抛错，并丢失其屏蔽）。
- 设置页按工作区 server 显示：配置状态（`configured` / `disabled` / `conflict` / `error`）、运行 agent 数、已连接 agent 数（工具可见）与最近错误。
- profile 级 server（来自 bundle 或 profile `cordis.patch.yml` 的 mcp-client 行）可在设置页禁用/启用：经宿主插件管理器在 profile `cordis.patch.yml` 写入 `disabled` 覆盖并立即对所有会话生效；插件管理器无法定位的行（位于 group 内、id 重复）会给出原因。
- 按工具选择：每行的 **工具** 按钮列出该 server 的工具，逐个勾选。工作区 server 保存为 mcp.json 的 `excludeTools`，仅更新 agent 绑定，不重启后端；工具列表在工具发现完成后出现。profile 级 server 保存到 `<profileDir>/dshmm/tools.json`（`{ "excludeTools": { "<serverName>": ["<工具名>"] } }`，可手改），各 agent 在下个 turn 经 `tools.restrict` 隐藏；卸载本插件即解除。
- Windows 上建议直接用 `node` 启动 stdio server：停止时只结束直接子进程，`cmd /c npx …` 包装可能遗留孤儿进程。

### 插件配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `agentIdleTimeoutMs` | `900000` | 已弃用且忽略，仅保留配置兼容性 |
| `agentMountWaitMs` | `30000`（30 秒） | `1000` – `2147483647`；会话启动 / 首个 turn 兜底等待上限 |
| `rescanIntervalMs` | `10000` | 工作区与配置发现 |

## 源码开发者

需要同时修改 deepseek-harness 和本插件源码时，参阅[源码开发者指南](Doc/development.zh.md)。两个仓库可以位于任意目录，不要求同级或固定路径。

验证顺序：`pnpm run check`，然后 `pnpm run test:e2e`（真实 stdio 进程、resources/instructions 隔离、重连与启动未完成时的清理）。

设计说明见 `Doc/requirements.md`。
