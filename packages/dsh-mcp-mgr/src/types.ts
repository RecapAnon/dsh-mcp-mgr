/**
 * Public payload types of the dsh-mcp-mgr Remote surface and internal state.
 * @module dsh-mcp-mgr/types
 */

/** Where one MCP server registration comes from. */
export type McpServerSource = 'workspace' | 'profile'

/**
 * Row status. Workspace rows carry the config status (`configured`,
 * `disabled`, `conflict`, `error`); profile rows report their fiber
 * (`active`, `error`, `configured`) or `conflict`.
 */
export type McpServerStatus =
  | 'active'
  | 'error'
  | 'conflict'
  | 'configured'
  | 'disabled'

/** One MCP server row as seen by the UI. */
export interface McpServerState {
  /** Stable row key: `<workspacePath>#<serverName>` for workspace rows, `profile#<entryId>` for profile rows. */
  readonly key: string
  /** Registration origin: workspace mcp.json or a profile-level config entry. */
  readonly source: McpServerSource
  /** serverName namespace (also the mcp.json entry name). */
  readonly name: string
  /** Absent on workspace rows whose entry failed to parse. */
  readonly transport?: 'stdio' | 'streamable-http'
  /** Workspace rows only: false when the mcp.json entry is disabled (`enabled: false`). */
  readonly enabled?: boolean
  readonly status: McpServerStatus
  /** Why the row is `error` / `conflict`. */
  readonly error?: string
  /** Workspace rows only: agents that currently hold a mount of this server. */
  readonly liveAgents?: number
  /** Workspace rows only: agents whose tool view contains `mcp__<name>__*`. */
  readonly connectedAgents?: number
  /** Workspace rows only: latest mount failure. */
  readonly lastError?: string
  /** Workspace source only: directory that contributed this server. */
  readonly workspace?: string
  /** Profile source only: config file declaring the entry. */
  readonly sourceFile?: string
}

/** Self-update check result served to the UI; '' means the value is unknown. */
export interface McpPluginVersionInfo {
  /** Installed host package version ('' when unreadable). */
  readonly localVersion: string
  /** Latest published version on the npm registry ('' when the check failed). */
  readonly latestVersion: string
  /** Whether an upgrade is available (latest > local, both known). */
  readonly updateAvailable: boolean
  /** Project URL carrying the update instructions. */
  readonly updateUrl: string
}

/** Full manager projection served to the UI. */
export interface McpManagerSnapshot {
  readonly servers: readonly McpServerState[]
  /** Workspace directories currently being discovered. */
  readonly watchedWorkspaces: readonly string[]
}

/** One server entry for create/update through the Remote. */
export interface McpServerDraft {
  /** Workspace directory owning the mcp.json to write. */
  readonly workspace: string
  /** serverName namespace; must match `[A-Za-z0-9_-]{1,32}`. */
  readonly name: string
  readonly transport: 'stdio' | 'streamable-http'
  /** stdio transport: executable. */
  readonly command?: string
  /** stdio transport: arguments. */
  readonly args?: readonly string[]
  /** stdio transport: extra env merged over the scrubbed ambient env. */
  readonly env?: Readonly<Record<string, string>>
  /** http transport: MCP endpoint URL. */
  readonly url?: string
  /** http transport: extra headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Child working directory; defaults to the workspace root. */
  readonly cwd?: string
}

export type McpApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }
