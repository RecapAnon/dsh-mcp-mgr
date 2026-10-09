/**
 * Workspace discovery: which directories contribute mcp.json files.
 *
 * Web profile: every registered workspace from `ctx.workspaceRegistry`; none
 * while the registry is still starting. Headless (or a failed registry
 * plugin): the process cwd.
 * The registry appears asynchronously (it waits for session persistence), so
 * callers re-probe on every rescan cycle instead of assuming it at startup.
 * @module dsh-mcp-mgr/discovery
 */

import { existsSync, realpathSync } from 'node:fs'
import { mcpJsonPath } from './parse.ts'

/** One directory that may own mcp.json. */
export interface WorkspaceSource {
  readonly path: string
}

/** Loader entry names of the web profile's workspace registry plugin. */
const WORKSPACE_ENTRY_NAMES = new Set(['@deepseek-ai/dsh-workspace', 'dsh-workspace'])
/** Cordis `FiberState.FAILED`. */
const FIBER_FAILED = 3

interface LoaderEntry {
  /** Effective state: true when the entry or an owning group is disabled. */
  readonly disabled?: unknown
  readonly options?: { readonly name?: unknown; readonly disabled?: unknown }
  readonly fiber?: { readonly state?: number }
}

interface LoaderView {
  entries(): Iterable<LoaderEntry>
}

/** Failed registry entries already reported. */
const reportedFailures = new WeakSet<object>()

/**
 * Canonicalize a workspace directory for comparisons and file mutations.
 * A missing directory is kept as an absolute path so discovery remains
 * deterministic; mutation callers still require realpath success.
 */
export function canonicalWorkspacePath(workspacePath: string): string {
  return nativeRealpath(workspacePath) ?? workspacePath
}

/** `realpath.native`, or undefined when the path does not resolve. */
export function nativeRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/**
 * Registered workspace paths: `undefined` when headless (no enabled registry
 * entry, or its plugin failed), empty while a web profile's registry is not
 * available yet.
 *
 * Uses `ctx.get` (never property access): un-injected service properties
 * throw under Cordis's inject guard, and `workspaceRegistry` is deliberately
 * not injected because it only exists in the web profile.
 */
function registeredPaths(ctx: unknown): readonly string[] | undefined {
  const registry = getService<{ list(): readonly { path: string }[] }>(ctx, 'workspaceRegistry')
  if (registry !== undefined) return registry.list().map(workspace => workspace.path)
  const entries = getService<LoaderView>(ctx, 'loader')?.entries() ?? []
  const entry = [...entries].find(item => item.disabled !== true && item.options?.disabled !== true
    && WORKSPACE_ENTRY_NAMES.has(String(item.options?.name)))
  if (entry === undefined) return undefined
  if (entry.fiber?.state !== FIBER_FAILED) return []
  if (!reportedFailures.has(entry)) {
    reportedFailures.add(entry)
    const logger = (ctx as { logger?: { warn(message: string): void } }).logger
    logger?.warn('mcp-mgr: workspace registry failed to start; falling back to the process cwd')
  }
  return undefined
}

/** Read the current workspace set from a Cordis context. */
export function collectWorkspaces(ctx: unknown): WorkspaceSource[] {
  const paths = registeredPaths(ctx) ?? [process.cwd()]
  return paths.map(path => ({ path: canonicalWorkspacePath(path) }))
}

/**
 * The workspace an agent belongs to: the registered one equal to
 * `realpath.native(cwd)`. Registry paths are canonical, so `known` (the
 * canonical set of the last rescan) only covers legacy non-canonical entries.
 * Headless: the process cwd, only when `cwd` resolves to it.
 */
export function agentWorkspace(ctx: unknown, cwd: string | undefined, known: ReadonlySet<string> = new Set()): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const real = nativeRealpath(cwd)
  if (real === undefined) return undefined
  const paths = registeredPaths(ctx)
  if (paths === undefined) return real === nativeRealpath(process.cwd()) ? real : undefined
  if (paths.length === 0) return undefined
  return paths.includes(real) || known.has(real) ? real : undefined
}

/** Whether a workspace currently carries a readable manager file. */
export function hasManagerFile(workspacePath: string): boolean {
  return existsSync(mcpJsonPath(workspacePath))
}

function getService<T>(ctx: unknown, name: string): T | undefined {
  return (ctx as { get?: (name: string) => unknown }).get?.(name) as T | undefined
}
