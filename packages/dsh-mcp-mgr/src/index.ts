/**
 * dsh-mcp-mgr: workspace-level MCP manager for DeepSeek Harness.
 *
 * Discovers `.dsh/dshmm/mcp.json` under every registered workspace (or the
 * process cwd in headless) and pools backends by workspace and server ID.
 * Session creation starts the backend; each agent gets scoped bindings.
 * A Typert Remote (`mcpMgr`) serves state and
 * write-back to the web UI.
 * @module dsh-mcp-mgr
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { openSharedServer } from './backend.ts'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { agentWorkspace, collectWorkspaces, hasManagerFile, nativeRealpath } from './discovery.ts'
import { AgentMounts } from './mounts.ts'
import { draftToEntry, mcpJsonPath, parseMcpJson, parseToolList, SERVER_NAME_PATTERN, validateDraft, type ParsedServer, type ParseResult } from './parse.ts'
import { parseProfileTools, ProfileRestrictions, profileToolsPath, toolKey } from './restrict.ts'
import { changeOutcome, isMcpClientEntry, profileServerNames, scanProfileEntries, type LoaderEntryView, type PluginChangeView } from './profile.ts'
import { createFileWatcher } from './watch.ts'
import { checkPluginVersion } from './version.ts'
import type { McpApplyResult, McpManagerSnapshot, McpPluginVersionInfo, McpServerDraft, McpServerState } from './types.ts'

export type * from './types.ts'
export { parseMcpJson, mcpJsonPath, expandEnv } from './parse.ts'
export { AgentMounts } from './mounts.ts'
export type { AgentBindingHandle, AgentScopeHandle, MountHandle, MountsHost, MountsOptions, SharedMountHandle, ToolFilter } from './mounts.ts'
export { ProfileRestrictions, parseProfileTools } from './restrict.ts'
export type { RestrictHost } from './restrict.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-mgr'

/** Services required before the manager starts mounting MCP clients. */
export const inject = ['tools']

/** The manager's Remote namespace. */
export const REMOTE_NAMESPACE = 'mcpMgr'

/** Plugin configuration supplied through cordis.yml. */
export interface Config {
  /** Master switch for workspace discovery. */
  enabled: boolean
  /** Periodic rescan interval covering workspaces added at runtime. */
  rescanIntervalMs: number
  /** Deprecated and ignored; retained for existing profile configurations. */
  agentIdleTimeoutMs: number
  /** Total mount wait budget of one agent activity (turn). */
  agentMountWaitMs: number
}

/** Largest delay `setTimeout` honours. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  rescanIntervalMs: Schema.number().min(1000).max(3600_000).default(10_000),
  agentIdleTimeoutMs: Schema.number().min(60_000).max(MAX_TIMER_DELAY_MS).default(900_000),
  agentMountWaitMs: Schema.number().min(1000).max(MAX_TIMER_DELAY_MS).default(30_000),
})

/** The host Agent members read here. */
interface AgentView {
  readonly status?: string
  readonly session?: { readonly header?: { readonly cwd?: string } }
  readonly ctx: { effect(execute: () => () => Promise<void>, label?: string): () => unknown }
}

/** Assembly context fields of a turn assembly. */
interface AssembleContextView {
  readonly agent?: object
  readonly signal?: AbortSignal
}

/** Host events subscribed here without depending on their packages' types. */
interface HostEvents {
  on(
    name: 'system-prompt/assemble',
    listener: (assembly: unknown, context: AssembleContextView | undefined, next: () => Promise<unknown>) => Promise<unknown>,
    options: { prepend: boolean },
  ): () => boolean
  on(name: 'agent/status', listener: (payload: { agent: object; status: string }) => void): () => boolean
  on(name: 'agent/created', listener: (payload: { agent: object; signal?: AbortSignal }) => Promise<void>): () => boolean
}

interface ToolsView {
  schemas(scope?: object): readonly { name: string }[]
  restrict(filter: { deny: readonly string[] }): () => void
  register(definition: { name: string }): () => void
}

const EMPTY_PARSE: ParseResult = { servers: [], errors: [] }

/**
 * The manager service: owns discovery, pooled backends, agent bindings, and the Remote
 * surface. `workspaceRegistry` is deliberately NOT injected — it is a web-only
 * service that appears asynchronously; discovery re-probes on every rescan.
 */
export class McpMgrGateway extends TypertRemoteService {
  private readonly mounts: AgentMounts
  private readonly restrictions: ProfileRestrictions
  /** `<workspace>#<server>` -> tool names the server listed to any agent. */
  private readonly toolCatalog = new Map<string, Set<string>>()
  /** Profile exclusions from `<profileDir>/dshmm/tools.json`. */
  private profileExclusions = new Map<string, string[]>()
  private profileToolsText: string | undefined
  private readonly fileWatcher = createFileWatcher(
    (handler, ms) => setTimeout(handler, ms),
    handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  )
  private readonly rescanTimer: ReturnType<typeof setInterval>
  private readonly parseCache = new Map<string, ParseResult>()
  private readonly workspaceSet = new Set<string>()
  /** Nested assemblies issued to pick up fresh registrations, with their base assembly. */
  private readonly reruns = new WeakMap<object, unknown>()
  /** Startup npm update check (fires once; never rejects). */
  private readonly versionCheck: Promise<McpPluginVersionInfo>
  private profileServers: readonly McpServerState[] = []
  private rescanning = false
  /** Serialized rescan chain so Remote-triggered passes apply in order. */
  private rescanChain: Promise<void> = Promise.resolve()
  /** Per-workspace lock for read-modify-write Remote mutations. */
  private readonly mutationChains = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcpMgr')
    this.mounts = new AgentMounts({
      workspaceOf: agent => agentWorkspace(ctx, (agent as AgentView).session?.header?.cwd, this.workspaceSet),
      candidates: workspace => this.candidates(workspace),
      openServer: (server, seen) => openSharedServer(ctx, viaStdioShim(server), seen),
      onAgentDispose: (agent, release) => {
        try {
          return (agent as AgentView).ctx.effect(() => release, 'mcp-mgr: agent mounts')
        } catch {
          return undefined
        }
      },
      isIdle: agent => (agent as AgentView).status !== 'running',
      toolSeen: (workspace, server, tool) => {
        const key = `${workspace}#${server}`
        let tools = this.toolCatalog.get(key)
        if (tools === undefined) this.toolCatalog.set(key, tools = new Set())
        tools.add(tool)
      },
      warn: message => { ctx.logger.warn(message) },
    }, { idleTimeoutMs: config.agentIdleTimeoutMs, mountWaitMs: config.agentMountWaitMs })
    this.restrictions = new ProfileRestrictions({
      exclusions: () => this.profileExclusions,
      globalToolNames: () => this.globalToolNames(),
      restrict: (agent, deny) => {
        const tools = getService<ToolsView>((agent as AgentView).ctx, 'tools')
        if (tools === undefined) throw new Error('tools service unavailable on the agent')
        return tools.restrict({ deny })
      },
      onAgentDispose: (agent, release) => {
        try {
          return (agent as AgentView).ctx.effect(() => async () => { release() }, 'mcp-mgr: agent tool restriction')
        } catch {
          return undefined
        }
      },
      warn: message => { ctx.logger.warn(message) },
    })
    const events = ctx as unknown as HostEvents
    // Tools are frozen at assembly: mount before it completes. When
    // registrations changed, a nested assembly yields a fresh base assembly
    // that replaces this one before the chain continues.
    events.on('system-prompt/assemble', async (assembly, context, next) => {
      const agent = context?.agent
      const signal = context?.signal
      if (context === undefined || agent === undefined || signal === undefined) return next()
      if (this.reruns.has(context)) {
        this.reruns.set(context, assembly)
        return assembly
      }
      const restricted = this.restrictions.apply(agent)
      const changed = await this.mounts.turn(agent, signal) || restricted
      const systemPrompt = getService<{ assemble(context: object): Promise<unknown> }>(ctx, 'systemPrompt')
      if (!changed || signal.aborted || systemPrompt === undefined || assembly === null || typeof assembly !== 'object') return next()
      const rerun = { ...context }
      this.reruns.set(rerun, undefined)
      try {
        await systemPrompt.assemble(rerun)
        const fresh = this.reruns.get(rerun)
        if (fresh !== null && typeof fresh === 'object') Object.assign(assembly, fresh)
      } catch (error) {
        ctx.logger.warn(`mcp-mgr: re-assembly failed: ${String(error instanceof Error ? error.message : error)}`)
      }
      return next()
    }, { prepend: true })
    events.on('agent/created', async ({ agent, signal }) => {
      await this.runRescan()
      await this.mounts.turn(agent, signal)
      this.mounts.status(agent, 'created')
    })
    events.on('agent/status', ({ agent, status }) => { this.mounts.status(agent, status) })
    this.rescanTimer = setInterval(() => {
      void this.runRescan()
    }, config.rescanIntervalMs)
    // Self-update check on startup; failures are silent by design.
    this.versionCheck = checkPluginVersion()
    void this.versionCheck.then(info => {
      if (info.updateAvailable) {
        ctx.logger.info(`mcp-mgr: update available: ${info.localVersion} -> ${info.latestVersion} (${info.updateUrl})`)
      } else if (info.latestVersion === '') {
        ctx.logger.warn('mcp-mgr: plugin update check failed (npm registry unreachable)')
      }
    })
    ctx.effect(() => async () => {
      this.fileWatcher.dispose()
      clearInterval(this.rescanTimer)
      this.restrictions.dispose()
      await this.mounts.dispose()
    }, 'mcp-mgr: cleanup')
    void this.runRescan()
  }

  /**
   * Self-update check result (startup npm lookup). Awaits the in-flight
   * check so the first UI load is deterministic; the check itself never
   * rejects, so this resolves as soon as the lookup settles.
   */
  @Remote('versionInfo')
  async versionInfo(): Promise<McpPluginVersionInfo> {
    return this.versionCheck
  }

  /** Full current projection for the UI. */
  @Remote('snapshot')
  snapshot(): McpManagerSnapshot {
    return {
      servers: [...this.workspaceRows(), ...this.profileRows()],
      watchedWorkspaces: [...this.workspaceSet].sort(),
    }
  }

  /**
   * Create one server entry in a workspace's mcp.json (file created when
   * absent). Resolves only after the resync settles, so a caller's follow-up
   * snapshot already reflects the new entry.
   */
  @Remote('apply')
  async apply(draft: McpServerDraft): Promise<McpApplyResult> {
    const invalid = validateDraft(draft)
    if (invalid !== undefined) return { ok: false, error: invalid }
    const workspacePath = this.resolveRegisteredWorkspace(draft.workspace)
    if (workspacePath === undefined) return { ok: false, error: `workspace is not registered: ${draft.workspace}` }
    const release = await this.acquireMutation(workspacePath)
    try {
      const path = mcpJsonPath(workspacePath)
    let document: { mcpServers?: Record<string, unknown> }
    try {
      document = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, error: `unreadable mcp.json: ${String(error instanceof Error ? error.message : error)}` }
      }
      document = {}
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      return { ok: false, error: 'mcp.json must contain a JSON object' }
    }
    const servers = document.mcpServers ?? {}
    if (typeof servers !== 'object' || Array.isArray(servers)) {
      return { ok: false, error: 'mcpServers must be an object' }
    }
    if (servers[draft.name] !== undefined) {
      return { ok: false, error: `serverName "${draft.name}" already exists in ${workspacePath}` }
    }
    servers[draft.name] = draftToEntry(draft)
    document.mcpServers = servers
    try {
      atomicWriteJson(path, document)
    } catch (error) {
      return { ok: false, error: `write failed: ${String(error instanceof Error ? error.message : error)}` }
    }
    // A brand-new file is not watched yet: resync now so the entry shows up
    // without waiting for the periodic rescan. The mutation invalidates the
    // parse cache, or this pass would re-sync the pre-write parse.
    this.parseCache.delete(workspacePath)
    await this.runRescan()
    return { ok: true }
    } finally {
      release()
    }
  }

  /**
   * Remove one server entry from a workspace's mcp.json.
   * Named `removeServer`: `remove` collides with the client gateway's
   * RemoteNamespaceService prototype method and fails contribution mounts.
   * Resolves only after the resync settles, so the caller's follow-up
   * snapshot already reflects the unload.
   */
  @Remote('removeServer')
  async removeServer(workspace: string, serverName: string): Promise<McpApplyResult> {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      return { ok: false, error: `invalid serverName: ${serverName}` }
    }
    const workspacePath = this.resolveRegisteredWorkspace(workspace)
    if (workspacePath === undefined) return { ok: false, error: `workspace is not registered: ${workspace}` }
    const release = await this.acquireMutation(workspacePath)
    try {
      const path = mcpJsonPath(workspacePath)
      if (!hasManagerFile(workspacePath)) {
        return { ok: false, error: `no mcp.json under ${workspacePath}` }
      }
    try {
      const document = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> }
      if (document.mcpServers !== undefined && typeof document.mcpServers === 'object') {
        delete (document.mcpServers as Record<string, unknown>)[serverName]
        if (Object.keys(document.mcpServers as Record<string, unknown>).length === 0) {
          delete document.mcpServers
        }
      }
      atomicWriteJson(path, document)
    } catch (error) {
      return { ok: false, error: `write failed: ${String(error instanceof Error ? error.message : error)}` }
    }
    // Invalidate the cached parse so the resync below drops the removed
    // entry instead of replaying the pre-write state.
    this.parseCache.delete(workspacePath)
    await this.runRescan()
    return { ok: true }
    } finally {
      release()
    }
  }

  /**
   * Enable or disable one server entry in a workspace's mcp.json. Disabling
   * writes `enabled: false`; enabling removes the field (absent = enabled).
   * Resolves only after the resync settles, so the caller's follow-up
   * snapshot already reflects the flag; disabling stops the server on every agent.
   */
  @Remote('setServerEnabled')
  async setServerEnabled(workspace: string, serverName: string, enabled: boolean): Promise<McpApplyResult> {
    return this.mutateEntry(workspace, serverName, (entry) => {
      if (enabled) delete entry.enabled
      else entry.enabled = false
    })
  }

  /**
   * Set the tools of one workspace server hidden from every agent
   * (`excludeTools` in mcp.json; an empty list removes the field). Agents
   * remount the server with the new filter at their next turn.
   */
  @Remote('setServerTools')
  async setServerTools(workspace: string, serverName: string, excludeTools: string[]): Promise<McpApplyResult> {
    const tools = parseToolList(excludeTools)
    if (tools === undefined) return { ok: false, error: 'excludeTools must be an array of non-empty strings' }
    return this.mutateEntry(workspace, serverName, (entry) => {
      if (tools.length === 0) delete entry.excludeTools
      else entry.excludeTools = tools
    })
  }

  /**
   * Set the tools of one profile-level server hidden from every agent, in
   * `<profileDir>/dshmm/tools.json`. Applied at each agent's next turn.
   */
  @Remote('setProfileServerTools')
  async setProfileServerTools(serverName: string, excludeTools: string[]): Promise<McpApplyResult> {
    if (!SERVER_NAME_PATTERN.test(serverName)) return { ok: false, error: `invalid serverName: ${serverName}` }
    const tools = parseToolList(excludeTools)
    if (tools === undefined) return { ok: false, error: 'excludeTools must be an array of non-empty strings' }
    const path = this.profileToolsFile()
    if (path === undefined) return { ok: false, error: 'no dsh profile is active; profile tool exclusions are unavailable' }
    const release = await this.acquireMutation(path)
    try {
      let document: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'tools.json must contain a JSON object' }
        document = parsed as Record<string, unknown>
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return { ok: false, error: `unreadable tools.json: ${String(error instanceof Error ? error.message : error)}` }
        }
        document = {}
      }
      const current = document.excludeTools ?? {}
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return { ok: false, error: '"excludeTools" must be an object' }
      const servers = current as Record<string, unknown>
      if (tools.length === 0) delete servers[serverName]
      else servers[serverName] = tools
      if (Object.keys(servers).length === 0) delete document.excludeTools
      else document.excludeTools = servers
      try {
        atomicWriteJson(path, document)
      } catch (error) {
        return { ok: false, error: `write failed: ${String(error instanceof Error ? error.message : error)}` }
      }
      this.loadProfileTools()
      return { ok: true }
    } finally {
      release()
    }
  }

  /**
   * Read-modify-write one server entry of a workspace's mcp.json, then resync.
   * Resolves only after the resync settles.
   */
  private async mutateEntry(workspace: string, serverName: string, mutate: (entry: Record<string, unknown>) => void): Promise<McpApplyResult> {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      return { ok: false, error: `invalid serverName: ${serverName}` }
    }
    const workspacePath = this.resolveRegisteredWorkspace(workspace)
    if (workspacePath === undefined) return { ok: false, error: `workspace is not registered: ${workspace}` }
    const release = await this.acquireMutation(workspacePath)
    try {
      const path = mcpJsonPath(workspacePath)
      if (!hasManagerFile(workspacePath)) {
        return { ok: false, error: `no mcp.json under ${workspacePath}` }
      }
      try {
        const document = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> }
        const servers = document.mcpServers
        if (servers === undefined || typeof servers !== 'object' || Array.isArray(servers)) {
          return { ok: false, error: 'mcpServers must be an object' }
        }
        const entry = servers[serverName]
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          return { ok: false, error: `serverName "${serverName}" not found in ${workspacePath}` }
        }
        mutate(entry as Record<string, unknown>)
        atomicWriteJson(path, document)
      } catch (error) {
        return { ok: false, error: `write failed: ${String(error instanceof Error ? error.message : error)}` }
      }
      // Invalidate the cached parse so the resync below applies the change
      // instead of replaying the pre-write state.
      this.parseCache.delete(workspacePath)
      await this.runRescan()
      return { ok: true }
    } finally {
      release()
    }
  }

  /**
   * Enable or disable one profile-level mcp-client entry through the host
   * plugin manager, which persists a `disabled` override in the profile patch
   * and applies it live. Resolves after the following rescan settles.
   */
  @Remote('setProfileServerEnabled')
  async setProfileServerEnabled(entryId: string, enabled: boolean): Promise<McpApplyResult> {
    const entry = this.loaderEntries().find(candidate => candidate.id === entryId)
    if (entry === undefined || !isMcpClientEntry(entry)) {
      return { ok: false, error: `not a profile MCP server entry: ${entryId}` }
    }
    const manager = getService<PluginManagerView>(this.ctx, 'pluginManager')
    if (manager === undefined) {
      return { ok: false, error: 'the host plugin manager is unavailable; edit the profile cordis.patch.yml instead' }
    }
    let result: PluginChangeView
    try {
      result = await manager.setPluginEnabled(entryId, enabled)
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error) }
    }
    await this.runRescan()
    return changeOutcome(result)
  }

  private resolveRegisteredWorkspace(input: string): string | undefined {
    const candidate = nativeRealpath(input)
    if (candidate === undefined) return undefined
    return collectWorkspaces(this.ctx).some(workspace => workspace.path === candidate) ? candidate : undefined
  }

  /** Serialize read-modify-write operations for one workspace file. */
  private async acquireMutation(workspacePath: string): Promise<() => void> {
    const previous = this.mutationChains.get(workspacePath)
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.mutationChains.set(workspacePath, current)
    if (previous !== undefined) await previous
    return () => {
      release()
      if (this.mutationChains.get(workspacePath) === current) this.mutationChains.delete(workspacePath)
    }
  }

  /**
   * Serialize rescan passes: a Remote-triggered pass must apply after any
   * in-flight one settles (a skipped pass would drop the newest selection).
   * @returns resolution after this queued pass settles.
   */
  private runRescan(): Promise<void> {
    const next = this.rescanChain.then(() => this.rescan(), () => this.rescan())
    this.rescanChain = next.catch(() => undefined)
    return next
  }

  /** One full discovery pass: refresh parsed configs and apply removals to live mounts. */
  async rescan(): Promise<void> {
    if (this.rescanning) return
    this.rescanning = true
    try {
      const workspaces = collectWorkspaces(this.ctx)
      const next = new Set(workspaces.map(workspace => workspace.path))
      const removed = [...this.workspaceSet].filter(path => !next.has(path))
      for (const path of removed) {
        this.workspaceSet.delete(path)
        this.parseCache.delete(path)
        await this.mounts.workspaceRemoved(path)
      }
      const watchFiles: string[] = []
      for (const workspace of workspaces) {
        if (!hasManagerFile(workspace.path)) {
          this.parseCache.delete(workspace.path)
          continue
        }
        watchFiles.push(mcpJsonPath(workspace.path))
        if (this.parseCache.has(workspace.path)) continue
        this.parseCache.set(workspace.path, this.readWorkspace(workspace.path, true))
      }
      for (const key of [...this.toolCatalog.keys()]) {
        const split = key.lastIndexOf('#')
        const servers = this.parseCache.get(key.slice(0, split))?.servers
        if (servers?.some(server => server.name === key.slice(split + 1)) !== true) this.toolCatalog.delete(key)
      }
      const profileTools = this.loadProfileTools()
      if (profileTools !== undefined) watchFiles.push(profileTools)
      this.fileWatcher.setWatchFiles(watchFiles, () => {
        this.parseCache.clear()
        void this.runRescan()
      })
      for (const path of next) this.workspaceSet.add(path)
      // Retire removed, disabled, conflicting or reconfigured backends once.
      // New backends and tool-filter edits bind on creation or the next turn.
      for (const path of [...next].sort()) await this.mounts.configChanged(path)
      const conflicts = new Set(this.workspaceRows().filter(row => row.status === 'conflict').map(row => row.name))
      this.profileServers = await scanProfileEntries(this.loaderEntries(), conflicts)
    } finally {
      this.rescanning = false
    }
  }

  /** `<profileDir>/dshmm/tools.json` of the running profile, if any. */
  private profileToolsFile(): string | undefined {
    const dir = getService<{ dir?: string }>(this.ctx, 'profileContext')?.dir
    return typeof dir === 'string' && dir.length > 0 ? profileToolsPath(dir) : undefined
  }

  /**
   * Re-read the profile exclusions; errors are warned once per file content.
   * @returns the file path when it exists (to watch it).
   */
  private loadProfileTools(): string | undefined {
    const path = this.profileToolsFile()
    let text: string | undefined
    try {
      if (path !== undefined) text = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.ctx.logger.warn(`mcp-mgr: cannot read ${path}: ${String(error)}`)
    }
    if (text === this.profileToolsText) return text === undefined ? undefined : path
    this.profileToolsText = text
    if (text === undefined) {
      this.profileExclusions = new Map()
      return undefined
    }
    const parsed = parseProfileTools(text)
    for (const error of parsed.errors) this.ctx.logger.warn(`mcp-mgr: ${path}: ${error}`)
    this.profileExclusions = parsed.exclusions
    return path
  }

  /** Names of the global tool layer (where profile-level servers register). */
  private globalToolNames(): string[] {
    const tools = getService<ToolsView>(this.ctx, 'tools')
    if (tools === undefined) return []
    try {
      return tools.schemas().map(schema => schema.name)
    } catch {
      return []
    }
  }

  /** Profile rows with their global tools and exclusions. */
  private profileRows(): McpServerState[] {
    const names = this.globalToolNames()
    return this.profileServers.map((row) => {
      const excluded = this.profileExclusions.get(row.name) ?? []
      const listed = names.flatMap(name => toolKey(row.name, name) ?? [])
      return { ...row, ...toolFields(listed, excluded) }
    })
  }

  /** Loader entries when the loader service is mounted (web profile). */
  private loaderEntries(): readonly LoaderEntryView[] {
    return getService<{ entries(): readonly LoaderEntryView[] }>(this.ctx, 'loader')?.entries() ?? []
  }

  private parsed(workspacePath: string): ParseResult {
    return this.parseCache.get(workspacePath)
      ?? (hasManagerFile(workspacePath) ? this.readWorkspace(workspacePath, false) : EMPTY_PARSE)
  }

  /** Enabled servers of a workspace not shadowed by a profile-level server, in mcp.json order. */
  private candidates(workspacePath: string): readonly ParsedServer[] {
    const reserved = profileServerNames(this.loaderEntries())
    return this.parsed(workspacePath).servers.filter(server => server.enabled && !reserved.has(server.name))
  }

  private workspaceRows(): McpServerState[] {
    const reserved = profileServerNames(this.loaderEntries())
    const tools = getService<ToolsView>(this.ctx, 'tools')
    const rows: McpServerState[] = []
    for (const workspace of [...this.workspaceSet].sort()) {
      const parsed = this.parseCache.get(workspace) ?? EMPTY_PARSE
      const views = tools === undefined ? [] : this.mounts.agentsIn(workspace).map(agent => toolNames(tools, agent))
      const workspaceRows: McpServerState[] = []
      for (const server of parsed.servers) {
        const owner = reserved.get(server.name)
        const status = !server.enabled ? 'disabled' : owner !== undefined ? 'conflict' : 'configured'
        const prefix = `mcp__${server.name}__`
        const connectedAgents = status !== 'configured'
          ? 0
          : views.filter(names => names.some(name => name.startsWith(prefix))).length
        const lastError = status === 'configured' ? this.mounts.lastError(workspace, server.name) : undefined
        workspaceRows.push({
          key: `${workspace}#${server.name}`,
          source: 'workspace',
          workspace,
          name: server.name,
          transport: server.config.transport,
          enabled: server.enabled,
          status,
          ...(status === 'conflict' ? { error: `serverName "${server.name}" is already used by profile-level mcp-client entry "${owner}"` } : {}),
          liveAgents: status === 'configured' ? this.mounts.liveAgents(workspace, server.name) : 0,
          connectedAgents,
          ...(lastError === undefined ? {} : { lastError }),
          ...toolFields(this.toolCatalog.get(`${workspace}#${server.name}`) ?? [], server.excludeTools),
        })
      }
      for (const error of parsed.errors) {
        workspaceRows.push({
          key: `${workspace}#${error.name}`,
          source: 'workspace',
          workspace,
          name: error.name,
          status: 'error',
          error: error.message,
          liveAgents: 0,
          connectedAgents: 0,
        })
      }
      rows.push(...workspaceRows.sort((left, right) => left.name.localeCompare(right.name)))
    }
    return rows
  }

  private readWorkspace(workspacePath: string, log: boolean): ParseResult {
    const path = mcpJsonPath(workspacePath)
    try {
      const parsed = parseMcpJson(readFileSync(path, 'utf8'), workspacePath)
      if (log) {
        for (const error of parsed.errors) {
          this.ctx.logger.warn(`mcp-mgr: ${workspacePath}: ${error.name}: ${error.message}`)
        }
      }
      return parsed
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
      if (log) this.ctx.logger.warn(`mcp-mgr: cannot read ${path}: ${message}`)
      return { servers: [], errors: [{ name: '(document)', message: `cannot read mcp.json: ${message}` }] }
    }
  }
}

/** Host plugin manager members used here. */
interface PluginManagerView {
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginChangeView>
}

/** Snapshot tool fields: every known name (excluded included) and the exclusions, omitted when empty. */
function toolFields(listed: Iterable<string>, excluded: readonly string[]): Pick<McpServerState, 'tools' | 'excludedTools'> {
  const tools = [...new Set([...listed, ...excluded])].sort()
  return {
    ...(tools.length === 0 ? {} : { tools }),
    ...(excluded.length === 0 ? {} : { excludedTools: [...excluded] }),
  }
}

function atomicWriteJson(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`)
  try {
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Optional service lookup through `ctx.get`: un-injected service properties
 * throw under Cordis's inject guard.
 */
function getService<T>(ctx: unknown, name: string): T | undefined {
  return (ctx as { get?: (name: string) => unknown }).get?.(name) as T | undefined
}

function toolNames(tools: ToolsView, agent: object): string[] {
  try {
    return tools.schemas(agent).map(schema => schema.name)
  } catch {
    return []
  }
}

/** The stdio shim and the cross-spawn of mcp-client's SDK, when both resolve. */
const STDIO_SHIM = resolveStdioShim()

function resolveStdioShim(): { script: string; spawnModule: string } | undefined {
  try {
    const sdk = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client')).resolve('@modelcontextprotocol/client/stdio')
    const script = fileURLToPath(new URL('./stdio-shim.js', import.meta.url))
    return existsSync(script) ? { script, spawnModule: createRequire(sdk).resolve('cross-spawn') } : undefined
  } catch {
    return undefined
  }
}

/** Launch a stdio server through the shim, so the era probe does not start it a second time. */
function viaStdioShim(config: McpClientConfig): McpClientConfig {
  if (config.transport !== 'stdio' || STDIO_SHIM === undefined) return config
  return { ...config, command: process.execPath, args: [STDIO_SHIM.script, STDIO_SHIM.spawnModule, config.command, ...config.args] }
}

/**
 * Plugin entry: register the gateway service.
 *
 * No default export: the loader's `unwrapExports` picks `exports.default`
 * when present, which would strip `Config` off the module namespace. A
 * namespace-shaped plugin (`name`/`inject`/`apply`/`Config` exports) is the
 * loader's object form.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new McpMgrGateway(ctx, config)
}
