# dsh-mcp-mgr

English | [中文](README.zh.md)

---

0.3.0 Update: Has been verified to be compatible with dsh@0.2.0-rc.2

```bash
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-mcp-mgr@0.3.0
```

---

A workspace-level MCP manager for DeepSeek Harness: it reads MCP servers from each workspace's `.dsh/dshmm/mcp.json`, registers their tools dynamically, and provides a management tab in the Web settings UI.

![MCP servers tab](Doc/assets/plugin-shot.jpg)

## Choose your workflow

| User | Entry point | Source checkouts required |
| --- | --- | --- |
| Regular user | npm package + `npx @deepseek-ai/dsh` | Neither deepseek-harness nor this repository |
| Source developer | deepseek-harness source + this repository source | See [Source Developer Guide](Doc/development.md) |

## Regular users: npm package

### Install and start

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-mcp-mgr@latest
npx @deepseek-ai/dsh web
```

Run the install command again to update:

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-mcp-mgr@latest
```

Uninstall:

```powershell
npx @deepseek-ai/dsh plugin --profile web remove dsh-mcp-mgr
```

### Workspace configuration

Create `.dsh/dshmm/mcp.json` at the workspace root:

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

Rules:

- A missing `type` is treated as Streamable HTTP; `${VAR}` environment expansion is supported.
- A stdio server without `cwd` uses the workspace root.
- `serverName` must be unique within one mcp.json; the same name may be used in other workspaces. A name equal to a profile-level mcp-client server is shown as `conflict` and never mounted.
- Set `"enabled": false` to disable an entry without removing it; absent means enabled.

## Behavior and limits

- Workspace tools use the `mcp__<serverName>__<tool>` naming convention.
- Servers are mounted per agent, lazily: an agent (main agent or subagent) mounts the servers of its session's workspace (`realpath` of the session `cwd` must equal a registered workspace; headless: only when it equals the process cwd; while the Web workspace registry is still starting, nothing mounts and the next turn retries) at its first turn. Opening a session starts nothing; a session outside any workspace gets no workspace tools.
- Each agent runs its own server processes, visible only to that agent. They stop after `agentIdleTimeoutMs` without a turn and remount at the next turn; they also stop when the agent is disposed or the plugin unloads.
- All mount waiting within one agent activity (running → idle), including the re-assembly, shares one `agentMountWaitMs` budget and ends at once when the turn is aborted; a server not ready by then is skipped, keeps connecting in the background and joins from a later step. A server that fails to start is shown as the last error and retried at the next turn.
- When a mount changes the agent's tools during prompt assembly, the assembly is recomputed once; `system-prompt/assemble` listeners prepended after this plugin run once more for that (their output of the extra run is discarded).
- mcp.json changes: a removed or disabled server stops at once on every agent; an added or changed one is applied at each agent's next turn.
- Every agent of a workspace gets all its enabled, non-conflict servers; there is no per-preset filtering.
- Compatibility: requires `dsh-preset-tool-access` **>= 0.2.1** (earlier versions' `restrict` throws on agent-scoped tool names and drops their denials).
- Settings shows per workspace server: config status (`configured` / `disabled` / `conflict` / `error`), running agents, connected agents (tools visible), and the last error.
- On Windows, prefer launching stdio servers with `node` directly: teardown kills only the direct child, so `cmd /c npx …` wrappers can leave orphaned processes.

### Plugin configuration

| Key | Default | Note |
| --- | --- | --- |
| `agentIdleTimeoutMs` | `900000` (15 min) | `60000` – `2147483647` |
| `agentMountWaitMs` | `30000` (30 s) | `1000` – `2147483647`; total mount wait per activity (running → idle) |
| `rescanIntervalMs` | `10000` | workspace and config discovery |

## Source developers

When modifying both deepseek-harness and this plugin from source, see the [Source Developer Guide](Doc/development.md). Both repositories may be anywhere; they do not need to be siblings or use fixed paths.

Design notes live in `Doc/requirements.md`.
