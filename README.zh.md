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
- 设置 `"enabled": false` 可禁用条目但不删除；缺省为启用。

## 行为与限制

- 工作区工具使用 `mcp__<serverName>__<tool>` 命名。
- 按 agent 懒挂载：agent（主 agent 或子 agent）在首个 turn 挂载其 session 所属工作区的 server（session `cwd` 的 realpath 须等于已登记工作区；headless 仅当其等于进程 cwd；Web 工作区登记服务尚未就绪时不挂载，下个 turn 重试）。仅打开会话不启动任何进程；不属于任何工作区的会话没有工作区工具。
- 每个 agent 运行自己的 server 进程，仅该 agent 可见；`agentIdleTimeoutMs` 内无 turn 即停止，下个 turn 重新挂载；agent 销毁或插件卸载时停止。
- 单次 agent 活动（running → idle）内所有挂载等待（含重新组装）共用一个 `agentMountWaitMs` 预算，turn 中止即停止等待；届时未就绪的 server 被跳过，在后台继续连接，连上后从后续 step 起可用。启动失败的 server 显示为最近错误，下个 turn 重试。
- 组装期间挂载改变了 agent 的工具时，提示词组装重算一次；在本插件之后 prepend 的 `system-prompt/assemble` 监听器会因此多执行一次（该次输出被丢弃）。
- mcp.json 变更：删除或禁用的 server 立即在所有 agent 上停止；新增或修改的 server 在各 agent 下个 turn 生效。
- 工作区内每个 agent 都获得该工作区全部启用且非 conflict 的 server；不按 preset 过滤。
- 兼容性：需要 `dsh-preset-tool-access` **>= 0.2.1**（更早版本的 `restrict` 遇到 agent 作用域工具名会抛错，并丢失其屏蔽）。
- 设置页按工作区 server 显示：配置状态（`configured` / `disabled` / `conflict` / `error`）、运行 agent 数、已连接 agent 数（工具可见）与最近错误。
- Windows 上建议直接用 `node` 启动 stdio server：停止时只结束直接子进程，`cmd /c npx …` 包装可能遗留孤儿进程。

### 插件配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `agentIdleTimeoutMs` | `900000`（15 分钟） | `60000` – `2147483647` |
| `agentMountWaitMs` | `30000`（30 秒） | `1000` – `2147483647`；单次活动（running → idle）挂载等待总预算 |
| `rescanIntervalMs` | `10000` | 工作区与配置发现 |

## 源码开发者

需要同时修改 deepseek-harness 和本插件源码时，参阅[源码开发者指南](Doc/development.zh.md)。两个仓库可以位于任意目录，不要求同级或固定路径。

设计说明见 `Doc/requirements.md`。
