# dsh-mcp-mgr

English | [中文](README.zh.md)

---

0.3.0 Update: Has been verified to be compatible with dsh@0.2.0-rc.2

```bash
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-mcp-mgr@0.3.0
```

---

A workspace-level MCP manager for DeepSeek Harness: it reads MCP servers from each workspace's `.dsh/dshmm/mcp.json`, registers their tools dynamically, and provides a management page in the Web UI, opened from the **MCP** row in the left sidebar.

![MCP servers page](Doc/assets/plugin-shot.jpg)

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
- Backends are shared by workspace by default (`"scope": "workspace"`, or omit `scope`). Set `"scope": "agent"` for a separate backend per agent when server state must be isolated.
- Set `"enabled": false` to disable an entry without removing it; absent means enabled.
- Set `"excludeTools": ["<tool>", ...]` to hide some of a server's tools from every agent (they are never registered, so they never reach the prompt). Tool names are the part after `mcp__<serverName>__`, which is the server's own name unless it contains characters outside `[A-Za-z0-9_-]`.

## Behavior and limits

- Workspace tools use the `mcp__<serverName>__<tool>` naming convention.
- In one DSH host, the backend pool is keyed by **canonical workspace path + server ID**. Different workspaces can each define `graphiti` with their own configuration and memory namespace; no global renaming is needed. Agents and subagents in the same workspace reuse its backend, including an in-progress startup.
- Startup begins on `agent/created` (session creation/resume), with a first-turn fallback for existing agents or late workspace discovery. The session `cwd` realpath must equal a registered workspace (headless: the process cwd); while the Web workspace registry is starting, nothing mounts and the next turn retries. Sessions outside a workspace get no workspace tools.
- Tools, resources, and server instructions remain agent-scoped even when the backend is shared. Shared backends stay warm across idle periods and disposal of the last agent; they stop on server disable/removal, transport configuration changes, workspace removal, manager unload, or host shutdown. With `"scope": "agent"`, the backend instead belongs to its agent and stops when that agent is disposed; neither mode restarts on idle.
- Shared backends also share mutable server state (for example, an active project or browser session). Use `"scope": "agent"` when this is unsuitable. The first cold startup still takes time; pooling avoids repeating it for subsequent agents.
- Workspace stdio servers start through a small `node` launcher (`lib/types/stdio-shim.js`) that answers mcp-client's `server/discover` protocol-era probe itself. Without it the probe runs on a throw-away second copy of the server, so a slow server (e.g. `uv run --isolated`) started twice per mount. Workspace stdio servers therefore always use the pre-2026 (legacy) MCP handshake.
- Session-start waiting is bounded by `agentMountWaitMs`; first-turn fallback waiting is bounded too. Timeout or abort stops that agent's wait, not shared startup. A server still connecting continues in the background and becomes available in a later assembly; a startup failure is shown as the last error.
- When a mount changes the agent's tools during prompt assembly, the assembly is recomputed once; `system-prompt/assemble` listeners prepended after this plugin run once more for that (their output of the extra run is discarded).
- mcp.json changes: removing or disabling a server stops its backends and removes its bindings. Transport configuration or scope changes replace the affected backend; `excludeTools` changes update agent bindings only, without restarting the process.
- Every agent of a workspace gets all its enabled, non-conflict servers; there is no per-preset filtering.
- Compatibility: requires `dsh-preset-tool-access` **>= 0.2.1** (earlier versions' `restrict` throws on agent-scoped tool names and drops their denials).
- The MCP page shows per workspace server: config status (`configured` / `disabled` / `conflict` / `error`), running agents, connected agents (tools visible), and the last error.
- Profile-level servers (mcp-client rows from bundles or the profile `cordis.patch.yml`) can be disabled and re-enabled on the MCP page. The change goes through the host plugin manager, which writes a `disabled` override into the profile `cordis.patch.yml` and applies it live to every session. Rows the plugin manager cannot address (inside a group, duplicate id) report why.
- Per-tool selection: each row's **Tools** button lists the server's tools with a checkbox each. Workspace servers save to `excludeTools` in mcp.json and update agent bindings without a backend restart; their list appears after tool discovery. Profile-level servers save to `<profileDir>/dshmm/tools.json` (`{ "excludeTools": { "<serverName>": ["<tool>"] } }`, hand-editable) and are hidden per agent with `tools.restrict` at its next turn; unloading this plugin lifts those restrictions.
- On Windows, prefer launching stdio servers with `node` directly: teardown kills only the direct child, so `cmd /c npx …` wrappers can leave orphaned processes.

### Plugin configuration

| Key | Default | Note |
| --- | --- | --- |
| `agentIdleTimeoutMs` | `900000` | Deprecated and ignored; retained for configuration compatibility |
| `agentMountWaitMs` | `30000` (30 s) | `1000` – `2147483647`; bounded session-start / first-turn fallback wait |
| `rescanIntervalMs` | `10000` | workspace and config discovery |

## Source developers

When modifying both deepseek-harness and this plugin from source, see the [Source Developer Guide](Doc/development.md). Both repositories may be anywhere; they do not need to be siblings or use fixed paths.

Validate with `pnpm run check`, then `pnpm run test:e2e` (real stdio processes, resource/instruction isolation, reconnect, and pending-startup teardown).

Design notes live in `Doc/requirements.md`.
