/** Workspace-owned MCP backends with lightweight, agent-scoped bindings. */
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { ParsedServer } from './parse.ts'

export interface MountHandle {
  readonly ready: Promise<void>
  dispose(): Promise<void>
}

export interface ToolFilter {
  readonly exclude: ReadonlySet<string>
  seen(tool: string): void
}

/** Legacy integration seam retained for consumers of the exported type. */
export interface AgentScopeHandle {
  mount(config: McpClientConfig, filter: ToolFilter): MountHandle
  dispose(): Promise<void>
}

export interface AgentBindingHandle {
  update(exclude: ReadonlySet<string>): boolean | void
  dispose(): Promise<void>
}

export interface SharedMountHandle extends MountHandle {
  bind(agent: object, exclude: ReadonlySet<string>): AgentBindingHandle
}

export interface MountsHost {
  workspaceOf(agent: object): string | undefined
  candidates(workspace: string): readonly ParsedServer[]
  openServer(config: McpClientConfig, seen: (tool: string) => void): SharedMountHandle
  onAgentDispose(agent: object, release: () => Promise<void>): (() => void) | undefined
  isIdle(agent: object): boolean
  toolSeen(workspace: string, server: string, tool: string): void
  warn(message: string): void
}

export interface MountsOptions {
  /** Deprecated: backends stay warm until their workspace/configuration is removed. */
  readonly idleTimeoutMs: number
  readonly mountWaitMs: number
}

interface Live {
  readonly workspace: string
  readonly name: string
  readonly owner: object | undefined
  readonly fingerprint: string
  readonly handle: SharedMountHandle
  ready: Promise<void>
  settled: boolean
  failed: boolean
  stopping?: Promise<void>
}

interface Attachment {
  readonly live: Live
  readonly binding: AgentBindingHandle
  exclusions: string
}

interface AgentState {
  readonly agent: object
  workspace: string | undefined
  readonly servers: Map<string, Attachment>
  generation: number
  chain: Promise<unknown>
  pass: Promise<Pass> | undefined
  deadline: number | undefined
  unhook: () => void
}

interface Pass {
  readonly done: Promise<void>
}
const SETTLED: Pass = { done: Promise.resolve() }

export class AgentMounts {
  private readonly states = new Map<object, AgentState>()
  private readonly pool = new Map<string, Map<string, Live>>()
  private readonly backends = new Set<Live>()
  private readonly mountErrors = new Map<string, Map<string, string>>()
  private closed = false

  constructor(private readonly host: MountsHost, private readonly options: MountsOptions) {}

  /** Cancellation ends only this wait, never the shared startup. */
  async turn(agent: object, signal?: AbortSignal): Promise<boolean> {
    const state = this.stateOf(agent)
    if (state === undefined) return false
    const start = state.generation
    const deadline = state.deadline ??= Date.now() + this.options.mountWaitMs
    state.pass ??= this.locked(state, () => this.runPass(state))
      .catch((error: unknown) => {
        this.host.warn(`mcp-mgr: mount failed: ${message(error)}`)
        return SETTLED
      })
      .finally(() => { state.pass = undefined })
    await settleBy(state.pass.then(pass => pass.done), deadline, signal)
    return state.generation !== start
  }

  status(agent: object, _status: string): void {
    const state = this.states.get(agent)
    if (state !== undefined) state.deadline = undefined
  }

  /** Invalidated backends stop once for all subscribers; filter-only edits stay warm. */
  async configChanged(workspace: string): Promise<void> {
    const wanted = new Map(this.host.candidates(workspace).map(server => [server.name, server]))
    const errors = this.mountErrors.get(workspace)
    for (const name of errors?.keys() ?? []) if (!wanted.has(name)) errors?.delete(name)
    await Promise.all([...this.backends].filter(live => live.workspace === workspace &&
      live.fingerprint !== fingerprintOf(wanted.get(live.name))).map(live => this.stopLive(live)))
  }

  async workspaceRemoved(workspace: string): Promise<void> {
    this.mountErrors.delete(workspace)
    await Promise.all([...this.backends].filter(live => live.workspace === workspace).map(live => this.stopLive(live)))
  }

  async release(agent: object): Promise<void> {
    const state = this.states.get(agent)
    if (state === undefined) return
    this.states.delete(agent)
    try { state.unhook() } catch { /* the agent may already be disposing */ }
    // Do not queue behind a startup that may never finish.
    await Promise.all([...state.servers.keys()].map(name => this.detach(state, name)))
  }

  async dispose(): Promise<void> {
    this.closed = true
    await Promise.all([...this.states.keys()].map(agent => this.release(agent)))
    await Promise.all([...this.backends].map(live => this.stopLive(live)))
  }

  agentsIn(workspace: string): object[] {
    return [...this.states.values()].filter(state => state.workspace === workspace).map(state => state.agent)
  }

  liveAgents(workspace: string, name: string): number {
    return [...this.states.values()].filter(state => state.workspace === workspace && state.servers.has(name)).length
  }

  lastError(workspace: string, name: string): string | undefined {
    return this.mountErrors.get(workspace)?.get(name)
  }

  private stateOf(agent: object): AgentState | undefined {
    const existing = this.states.get(agent)
    if (existing !== undefined || this.closed) return existing
    const unhook = this.host.onAgentDispose(agent, () => this.release(agent))
    if (unhook === undefined) return undefined
    const state: AgentState = {
      agent, workspace: undefined, servers: new Map(), generation: 0,
      chain: Promise.resolve(), pass: undefined, deadline: undefined, unhook,
    }
    this.states.set(agent, state)
    return state
  }

  private alive(state: AgentState): boolean {
    return !this.closed && this.states.get(state.agent) === state
  }

  private async runPass(state: AgentState): Promise<Pass> {
    if (!this.alive(state)) return SETTLED
    const workspace = this.host.workspaceOf(state.agent)
    if (workspace !== state.workspace) {
      await Promise.all([...state.servers.keys()].map(name => this.detach(state, name)))
      state.workspace = workspace
    }
    if (workspace === undefined || !this.alive(state)) return SETTLED
    const wanted = this.host.candidates(workspace)
    const byName = new Map(wanted.map(server => [server.name, server]))
    await Promise.all([...state.servers].filter(([name]) => !byName.has(name)).map(([name]) => this.detach(state, name)))
    const passes = await Promise.all(wanted.map(server => this.ensure(state, workspace, server)))
    return { done: Promise.all(passes.map(pass => pass.done)).then(() => undefined) }
  }

  private async ensure(state: AgentState, workspace: string, server: ParsedServer): Promise<Pass> {
    const fingerprint = fingerprintOf(server)
    let attachment = state.servers.get(server.name)
    if (attachment !== undefined && (attachment.live.failed || attachment.live.fingerprint !== fingerprint)) {
      await this.stopLive(attachment.live)
      attachment = undefined
    }
    const shared = server.scope !== 'agent'
    let live = attachment?.live ?? (shared ? this.pool.get(workspace)?.get(server.name) : undefined)
    while (live !== undefined && (live.failed || live.stopping !== undefined || live.fingerprint !== fingerprint)) {
      await this.stopLive(live)
      live = shared ? this.pool.get(workspace)?.get(server.name) : undefined
      attachment = state.servers.get(server.name)
    }
    if (!this.alive(state) || this.host.workspaceOf(state.agent) !== workspace ||
      !this.host.candidates(workspace).some(candidate => candidate.name === server.name && fingerprintOf(candidate) === fingerprint)) return SETTLED
    if (live === undefined) {
      try {
        const handle = this.host.openServer(server.config, tool => { this.host.toolSeen(workspace, server.name, tool) })
        live = { workspace, name: server.name, owner: shared ? undefined : state.agent,
          fingerprint, handle, ready: Promise.resolve(), settled: false, failed: false }
        this.backends.add(live)
        if (shared) {
          let servers = this.pool.get(workspace)
          if (servers === undefined) this.pool.set(workspace, servers = new Map())
          servers.set(server.name, live)
        }
        const current = live
        current.ready = handle.ready.then(() => {
          current.settled = true
          if (current.stopping !== undefined) return
          this.mountErrors.get(workspace)?.delete(server.name)
          for (const subscriber of this.states.values()) {
            if (subscriber.servers.get(server.name)?.live === current) subscriber.generation += 1
          }
        }, async (error: unknown) => {
          current.failed = true
          current.settled = true
          if (current.stopping !== undefined) return
          this.mountFailed(workspace, server.name, error)
          await this.stopLive(current)
        })
      } catch (error) {
        this.mountFailed(workspace, server.name, error)
        return SETTLED
      }
    }
    try {
      const exclusions = JSON.stringify(server.excludeTools)
      if (attachment === undefined || attachment.live !== live) {
        const binding = live.handle.bind(state.agent, new Set(server.excludeTools))
        state.servers.set(server.name, { live, binding, exclusions })
        if (live.settled) state.generation += 1
      } else {
        const repaired = attachment.binding.update(new Set(server.excludeTools)) === true
        if (attachment.exclusions !== exclusions || repaired) state.generation += 1
        attachment.exclusions = exclusions
      }
      return { done: live.ready }
    } catch (error) {
      this.host.warn(`mcp-mgr: ${workspace}#${server.name}: agent binding failed: ${message(error)}`)
      if (live.owner === state.agent) await this.stopLive(live)
      return SETTLED
    }
  }

  private async detach(state: AgentState, name: string): Promise<void> {
    const attachment = state.servers.get(name)
    if (attachment === undefined) return
    state.servers.delete(name)
    state.generation += 1
    await attachment.binding.dispose().catch(error => { this.host.warn(`mcp-mgr: binding dispose failed: ${message(error)}`) })
    if (attachment.live.owner === state.agent) await this.stopLive(attachment.live)
  }

  private stopLive(live: Live): Promise<void> {
    if (live.stopping !== undefined) return live.stopping
    // Publish the shutdown barrier before any binding/transport disposer runs.
    live.stopping = Promise.resolve().then(async () => {
      await Promise.all([...this.states.values()].map(async state => {
        const attachment = state.servers.get(live.name)
        if (attachment?.live !== live) return
        state.servers.delete(live.name)
        if (!live.failed) state.generation += 1
        await attachment.binding.dispose().catch(error => { this.host.warn(`mcp-mgr: binding dispose failed: ${message(error)}`) })
      }))
      await live.handle.dispose()
    }).catch(error => { this.host.warn(`mcp-mgr: dispose failed: ${message(error)}`) }).finally(() => {
      this.backends.delete(live)
      const servers = this.pool.get(live.workspace)
      if (servers?.get(live.name) === live) servers.delete(live.name)
      if (servers?.size === 0) this.pool.delete(live.workspace)
    })
    return live.stopping
  }

  private mountFailed(workspace: string, name: string, error: unknown): void {
    const text = message(error)
    let errors = this.mountErrors.get(workspace)
    if (errors === undefined) this.mountErrors.set(workspace, errors = new Map())
    if (errors.get(name) === text) return
    errors.set(name, text)
    this.host.warn(`mcp-mgr: ${workspace}#${name}: mount failed: ${text}`)
  }

  private locked<T>(state: AgentState, run: () => Promise<T>): Promise<T> {
    const next = state.chain.then(run, run)
    state.chain = next.catch(() => undefined)
    return next
  }
}

function fingerprintOf(server: ParsedServer): string
function fingerprintOf(server: ParsedServer | undefined): string | undefined
function fingerprintOf(server: ParsedServer | undefined): string | undefined {
  return server === undefined ? undefined : JSON.stringify([server.config, server.scope ?? 'workspace'])
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function settleBy(done: Promise<unknown>, deadline: number, signal?: AbortSignal): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0 || signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, remaining)
    signal?.addEventListener('abort', finish, { once: true })
    void done.then(finish, finish)
  })
}
