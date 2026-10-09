/**
 * Per-agent lazy mounts of a workspace's MCP servers.
 *
 * An agent's workspace servers mount into an agent-keyed scope at turn
 * assembly, stop after an idle timeout, and are disposed with the agent, on
 * config removal, or when the manager closes. Host access is injected so the
 * lifecycle runs without a real host in tests.
 * @module dsh-mcp-mgr/mounts
 */

import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { ParsedServer } from './parse.ts'

/** One mounted mcp-client instance. */
export interface MountHandle {
  /** Settles once the instance activated (initial connect + tool discovery). */
  readonly ready: Promise<void>
  dispose(): Promise<void>
}

/** An agent-keyed registration scope. */
export interface AgentScopeHandle {
  mount(config: McpClientConfig): MountHandle
  dispose(): Promise<void>
}

/** Host seams used by {@link AgentMounts}. */
export interface MountsHost {
  /** The registered workspace the agent belongs to, if any. */
  workspaceOf(agent: object): string | undefined
  /** Enabled, non-conflict servers of a workspace in mcp.json order. */
  candidates(workspace: string): readonly ParsedServer[]
  openScope(agent: object): AgentScopeHandle
  /** Run `release` when the agent is disposed; undefined when the agent is already inactive. */
  onAgentDispose(agent: object, release: () => Promise<void>): (() => void) | undefined
  isIdle(agent: object): boolean
  warn(message: string): void
}

export interface MountsOptions {
  readonly idleTimeoutMs: number
  readonly mountWaitMs: number
}

interface Live {
  readonly config: McpClientConfig
  readonly handle: MountHandle
  settled: boolean
  failed: boolean
  ready?: Promise<void>
}

interface AgentState {
  readonly agent: object
  workspace: string | undefined
  scope: AgentScopeHandle | undefined
  readonly servers: Map<string, Live>
  /** Bumped whenever this agent's registrations change. */
  generation: number
  /** Serializes reconcile and stop work. */
  chain: Promise<unknown>
  pass: Promise<Pass> | undefined
  /** Mount wait deadline of the current activity. */
  deadline: number | undefined
  idleTimer: ReturnType<typeof setTimeout> | undefined
  unhook: () => void
}

interface Pass {
  readonly done: Promise<void>
}

const SETTLED: Pass = { done: Promise.resolve() }

export class AgentMounts {
  private readonly states = new Map<object, AgentState>()
  private readonly mountErrors = new Map<string, string>()
  private closed = false

  constructor(private readonly host: MountsHost, private readonly options: MountsOptions) {}

  /**
   * Reconcile the agent's mounts for one turn assembly and wait for them, at
   * most until the activity's mount deadline or `signal` aborts. Work past
   * that point continues in the background.
   * @returns whether the agent's registrations changed meanwhile.
   */
  async turn(agent: object, signal?: AbortSignal): Promise<boolean> {
    const state = this.stateOf(agent)
    if (state === undefined) return false
    this.clearIdle(state)
    const start = state.generation
    const deadline = state.deadline ??= Date.now() + this.options.mountWaitMs
    state.pass ??= this.runPass(state)
      .catch((error: unknown) => {
        this.host.warn(`mcp-mgr: mount failed: ${message(error)}`)
        return SETTLED
      })
      .finally(() => { state.pass = undefined })
    await settleBy(state.pass.then(pass => pass.done), deadline, signal)
    return state.generation !== start
  }

  /** Track `agent/status`: idle arms the idle stop, running clears it. */
  status(agent: object, status: string): void {
    const state = this.states.get(agent)
    if (state === undefined) return
    state.deadline = undefined
    if (status === 'idle') this.armIdle(state)
    else this.clearIdle(state)
  }

  /** Stop, on every agent of the workspace, servers that are no longer candidates. */
  async configChanged(workspace: string): Promise<void> {
    const names = new Set(this.host.candidates(workspace).map(server => server.name))
    this.clearErrors(workspace, name => !names.has(name))
    await Promise.all(this.statesIn(workspace).map(state => this.locked(state, () =>
      this.stop(state, [...state.servers.keys()].filter(name => !names.has(name))))))
  }

  /** Stop every agent mount of a removed workspace. */
  async workspaceRemoved(workspace: string): Promise<void> {
    this.clearErrors(workspace, () => true)
    await Promise.all(this.statesIn(workspace).map(state => this.locked(state, () =>
      this.stop(state, [...state.servers.keys()]))))
  }

  /** Forget an agent and dispose its mounts. */
  release(agent: object): Promise<void> {
    const state = this.states.get(agent)
    if (state === undefined) return Promise.resolve()
    this.states.delete(agent)
    this.clearIdle(state)
    return this.locked(state, () => this.stop(state, [...state.servers.keys()]))
  }

  /** Dispose every agent mount; later turns mount nothing. */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.all([...this.states.values()].map((state) => {
      const stopped = this.release(state.agent)
      try { state.unhook() } catch { /* agent already inactive */ }
      return stopped
    }))
  }

  /** Agents currently resolved to the workspace. */
  agentsIn(workspace: string): object[] {
    return this.statesIn(workspace).map(state => state.agent)
  }

  /** Agents of the workspace holding a mount of `name`. */
  liveAgents(workspace: string, name: string): number {
    return this.statesIn(workspace).filter(state => state.servers.has(name)).length
  }

  lastError(workspace: string, name: string): string | undefined {
    return this.mountErrors.get(`${workspace}#${name}`)
  }

  private statesIn(workspace: string): AgentState[] {
    return [...this.states.values()].filter(state => state.workspace === workspace)
  }

  private stateOf(agent: object): AgentState | undefined {
    const existing = this.states.get(agent)
    if (existing !== undefined || this.closed) return existing
    const unhook = this.host.onAgentDispose(agent, () => this.release(agent))
    if (unhook === undefined) return undefined
    const state: AgentState = {
      agent,
      workspace: undefined,
      scope: undefined,
      servers: new Map(),
      generation: 0,
      chain: Promise.resolve(),
      pass: undefined,
      deadline: undefined,
      idleTimer: undefined,
      unhook,
    }
    this.states.set(agent, state)
    return state
  }

  private alive(state: AgentState): boolean {
    return !this.closed && this.states.get(state.agent) === state
  }

  private runPass(state: AgentState): Promise<Pass> {
    return this.locked(state, async (): Promise<Pass> => {
      if (!this.alive(state)) return SETTLED
      const workspace = this.host.workspaceOf(state.agent)
      if (workspace !== state.workspace) {
        await this.stop(state, [...state.servers.keys()])
        state.workspace = workspace
      }
      if (workspace === undefined) return SETTLED
      const wanted = this.host.candidates(workspace)
      const byName = new Map(wanted.map(server => [server.name, server]))
      await this.stop(state, [...state.servers]
        .filter(([name, live]) => live.failed || !sameConfig(live.config, byName.get(name)?.config))
        .map(([name]) => name))
      if (!this.alive(state)) return SETTLED
      const done = Promise.all(wanted.map(server => this.ensure(state, workspace, server))).then(() => undefined)
      if (state.servers.size === 0) await this.stop(state, [])
      return { done }
    })
  }

  private ensure(state: AgentState, workspace: string, server: ParsedServer): Promise<void> {
    const existing = state.servers.get(server.name)
    if (existing !== undefined) return existing.settled ? Promise.resolve() : existing.ready ?? Promise.resolve()
    const key = `${workspace}#${server.name}`
    let handle: MountHandle
    try {
      state.scope ??= this.host.openScope(state.agent)
      handle = state.scope.mount(server.config)
    } catch (error) {
      this.mountFailed(key, error)
      return Promise.resolve()
    }
    const live: Live = { config: server.config, handle, settled: false, failed: false }
    state.servers.set(server.name, live)
    live.ready = handle.ready.then(() => {
      live.settled = true
      if (state.servers.get(server.name) !== live) return
      this.mountErrors.delete(key)
      state.generation += 1
      if (this.host.isIdle(state.agent)) this.armIdle(state)
    }, (error: unknown) => {
      live.settled = true
      live.failed = true
      if (state.servers.get(server.name) !== live) return
      this.mountFailed(key, error)
      void this.locked(state, async () => {
        if (state.servers.get(server.name) === live) await this.stop(state, [server.name])
      })
    })
    return live.ready
  }

  /** Record a mount failure; warn only when the error for the key changes. */
  private mountFailed(key: string, error: unknown): void {
    const text = message(error)
    if (this.mountErrors.get(key) === text) return
    this.mountErrors.set(key, text)
    this.host.warn(`mcp-mgr: ${key}: mount failed: ${text}`)
  }

  private clearErrors(workspace: string, matches: (name: string) => boolean): void {
    const prefix = `${workspace}#`
    for (const key of [...this.mountErrors.keys()]) {
      if (key.startsWith(prefix) && matches(key.slice(prefix.length))) this.mountErrors.delete(key)
    }
  }

  private async stop(state: AgentState, names: readonly string[]): Promise<void> {
    const removed: Live[] = []
    for (const name of names) {
      const live = state.servers.get(name)
      if (live === undefined) continue
      state.servers.delete(name)
      removed.push(live)
    }
    await Promise.all(removed.map(live => live.handle.dispose().catch((error: unknown) => {
      this.host.warn(`mcp-mgr: dispose failed: ${message(error)}`)
    })))
    // A failed startup has already unloaded its registrations.
    if (removed.some(live => !live.failed)) state.generation += 1
    if (state.servers.size > 0) return
    this.clearIdle(state)
    const scope = state.scope
    state.scope = undefined
    await scope?.dispose().catch((error: unknown) => {
      this.host.warn(`mcp-mgr: scope dispose failed: ${message(error)}`)
    })
  }

  private armIdle(state: AgentState): void {
    if (state.idleTimer !== undefined || state.servers.size === 0 || !this.alive(state)) return
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined
      if (!this.alive(state) || !this.host.isIdle(state.agent)) return
      void this.locked(state, async () => {
        if (this.host.isIdle(state.agent)) await this.stop(state, [...state.servers.keys()])
      })
    }, this.options.idleTimeoutMs)
    state.idleTimer.unref?.()
  }

  private clearIdle(state: AgentState): void {
    if (state.idleTimer === undefined) return
    clearTimeout(state.idleTimer)
    state.idleTimer = undefined
  }

  private locked<T>(state: AgentState, run: () => Promise<T>): Promise<T> {
    const next = state.chain.then(run, run)
    state.chain = next.catch(() => undefined)
    return next
  }
}

function sameConfig(left: McpClientConfig, right: McpClientConfig | undefined): boolean {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve when `done` settles, the deadline passes or `signal` aborts. */
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
