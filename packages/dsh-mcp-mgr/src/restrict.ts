/**
 * Profile-level tool exclusions.
 *
 * Profile mcp-client servers register global tools, so excluded ones are
 * hidden per agent with `tools.restrict({ deny })` at each turn assembly.
 * The exclusion list lives in `<profileDir>/dshmm/tools.json`:
 * `{ "excludeTools": { "<serverName>": ["<tool>", ...] } }`.
 * @module dsh-mcp-mgr/restrict
 */

import { join } from 'node:path'
import { parseToolList } from './parse.ts'

/** serverName -> excluded tool names (public name without `mcp__<serverName>__`). */
export type ToolExclusions = ReadonlyMap<string, readonly string[]>

/** Path of the profile exclusion file. */
export function profileToolsPath(profileDir: string): string {
  return join(profileDir, 'dshmm', 'tools.json')
}

/**
 * Parse tools.json; invalid server entries are skipped with a reason.
 * @param text - raw file content.
 * @returns exclusions plus per-entry errors.
 */
export function parseProfileTools(text: string): { exclusions: Map<string, string[]>; errors: string[] } {
  const exclusions = new Map<string, string[]>()
  const errors: string[] = []
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return { exclusions, errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const raw = isRecord(document) ? document.excludeTools : undefined
  if (raw === undefined) return { exclusions, errors }
  if (!isRecord(raw)) return { exclusions, errors: ['"excludeTools" must be an object'] }
  for (const [server, value] of Object.entries(raw)) {
    const tools = parseToolList(value)
    if (tools === undefined) errors.push(`${server}: tool list must be an array of strings`)
    else if (tools.length > 0) exclusions.set(server, tools)
  }
  return { exclusions, errors }
}

/** Tool name without its `mcp__<server>__` prefix, or undefined when it is another server's. */
export function toolKey(server: string, publicName: string): string | undefined {
  const prefix = `mcp__${server}__`
  return publicName.startsWith(prefix) ? publicName.slice(prefix.length) : undefined
}

/** Host seams used by {@link ProfileRestrictions}. */
export interface RestrictHost {
  exclusions(): ToolExclusions
  /** Names of the global tool layer. */
  globalToolNames(): readonly string[]
  /** Install a deny restriction on the agent's scope; returns its disposer. */
  restrict(agent: object, deny: readonly string[]): () => void
  /** Run `release` when the agent is disposed; undefined when the agent is already inactive. */
  onAgentDispose(agent: object, release: () => void): (() => void) | undefined
  warn(message: string): void
}

interface RestrictState {
  key: string
  dispose: (() => void) | undefined
  readonly unhook: () => void
}

export class ProfileRestrictions {
  private readonly states = new Map<object, RestrictState>()
  private readonly warned = new Set<string>()
  private closed = false

  constructor(private readonly host: RestrictHost) {}

  /**
   * Bring the agent's deny restriction in line with the exclusions.
   * @returns whether the agent's visible tools changed.
   */
  apply(agent: object): boolean {
    if (this.closed) return false
    const deny = this.denyList()
    const key = deny.join('\n')
    let state = this.states.get(agent)
    if ((state?.key ?? '') === key) return false
    if (state === undefined) {
      const unhook = this.host.onAgentDispose(agent, () => { this.states.delete(agent) })
      if (unhook === undefined) return false
      state = { key: '', dispose: undefined, unhook }
      this.states.set(agent, state)
    }
    let dispose: (() => void) | undefined
    if (deny.length > 0) {
      try {
        dispose = this.host.restrict(agent, deny)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        if (!this.warned.has(text)) {
          this.warned.add(text)
          this.host.warn(`mcp-mgr: profile tool restriction failed: ${text}`)
        }
        return false
      }
    }
    const previous = state.dispose
    state.key = key
    state.dispose = dispose
    previous?.()
    return true
  }

  /** Lift every restriction installed here. */
  dispose(): void {
    this.closed = true
    for (const state of this.states.values()) {
      try { state.dispose?.() } catch { /* agent already disposed */ }
      try { state.unhook() } catch { /* agent already inactive */ }
    }
    this.states.clear()
  }

  private denyList(): string[] {
    const exclusions = this.host.exclusions()
    if (exclusions.size === 0) return []
    const deny: string[] = []
    for (const name of this.host.globalToolNames()) {
      for (const [server, tools] of exclusions) {
        const tool = toolKey(server, name)
        if (tool !== undefined && tools.includes(tool)) deny.push(name)
      }
    }
    return deny.sort()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
