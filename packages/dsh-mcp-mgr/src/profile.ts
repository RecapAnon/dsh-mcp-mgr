/**
 * Profile-level MCP server projection: scan the cordis config tree (profile
 * patches, bundles, --patch overlays) for mcp-client registrations and map
 * them to server rows with real runtime status. Enablement is changed through
 * the host plugin manager, never by editing patch files here.
 * @module dsh-mcp-mgr/profile
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpApplyResult, McpServerState } from './types.ts'

/** Cordis fiber states (numeric values mirror @deepseek-ai/cordis). */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

/** Plugin names matching profile-level mcp-client registrations. */
const MCP_CLIENT_ENTRY_NAMES = new Set(['@deepseek-ai/dsh-mcp-client', 'dsh-mcp-client'])

/** Loader entry view consumed by the profile scan. */
export interface LoaderEntryView {
  readonly id?: string
  readonly options?: {
    readonly id?: string
    readonly name?: unknown
    readonly disabled?: unknown
    readonly config?: { readonly serverName?: string; readonly transport?: string } | undefined
  }
  readonly fiber?: { readonly state?: number; await(): Promise<unknown> }
}

/**
 * serverNames of LIVE profile-level mcp-client instances, mapped to their
 * loader entry id. Their tools are global, so a workspace server with the same
 * name would shadow them: such workspace rows are `conflict` and never mount.
 */
export function profileServerNames(entries: readonly LoaderEntryView[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const entry of entries) {
    const options = entry.options ?? {}
    if (options.disabled === true) continue
    if (!MCP_CLIENT_ENTRY_NAMES.has(String(options.name))) continue
    const name = options.config?.serverName
    if (name === undefined) continue
    if (entry.fiber?.state === FIBER_ACTIVE) names.set(name, String(options.id ?? entry.id))
  }
  return names
}

/** Whether a loader entry is a profile-level mcp-client registration. */
export function isMcpClientEntry(entry: LoaderEntryView): boolean {
  return MCP_CLIENT_ENTRY_NAMES.has(String(entry.options?.name))
}

/**
 * Project profile-level mcp-client registrations as server rows.
 * Loader entries carry the resolved config and the live fiber, so status is
 * real: disabled entry -> disabled, active fiber -> active, failed fiber ->
 * error (e.g. duplicate serverName), otherwise -> configured. Enabled rows
 * colliding with a workspace serverName are flagged conflict.
 */
export async function scanProfileEntries(
  entries: readonly LoaderEntryView[],
  workspaceNames: ReadonlySet<string>,
  profilesDir = defaultProfilesDir(),
): Promise<McpServerState[]> {
  const rows: McpServerState[] = []
  for (const entry of entries) {
    const options = entry.options ?? {}
    if (!isMcpClientEntry(entry)) continue
    const config = options.config
    const name = config?.serverName
    if (name === undefined || config?.transport === undefined) continue
    // Prefer the raw yml id: the loader's `entry.id` getter prefixes parent
    // group ids, which never appear verbatim in the patch file.
    const rawId = String(options.id ?? entry.id)
    const enabled = options.disabled !== true
    const fiber = entry.fiber
    let status: McpServerState['status'] = enabled ? 'configured' : 'disabled'
    let error: string | undefined
    if (enabled && fiber !== undefined) {
      if (fiber.state === FIBER_ACTIVE) status = 'active'
      else if (fiber.state === FIBER_FAILED) {
        status = 'error'
        try { await fiber.await() } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure)
        }
      }
    }
    if (enabled && workspaceNames.has(name)) {
      status = 'conflict'
      error = `serverName "${name}" is also used by a workspace mcp.json`
    }
    const sourceFile = findProfilePatchFile(rawId, profilesDir)
    rows.push({
      key: `profile#${rawId}`,
      source: 'profile',
      name,
      transport: config.transport === 'stdio' ? 'stdio' : 'streamable-http',
      enabled,
      status,
      ...(entry.id === undefined ? {} : { entryId: entry.id }),
      ...(error === undefined ? {} : { error }),
      ...(sourceFile === undefined ? {} : { sourceFile }),
    })
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Find the profile patch file declaring a loader entry, by scanning every
 * `cordis.patch.yml` under the profiles directory for the entry's raw id.
 * Loader entries do not expose their source file, so this probe is the
 * lightweight stand-in; overlay (--patch) declarations are not found.
 */
export function findProfilePatchFile(entryId: string, profilesDir = defaultProfilesDir()): string | undefined {
  // Entry ids are [A-Za-z0-9_-]; tolerate quoting and spacing variants.
  const idPattern = new RegExp(`id:\\s*['"]?${entryId}(?:['"]|\\s|$)`)
  let profileNames: string[]
  try {
    profileNames = readdirSync(profilesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return undefined
  }
  for (const name of profileNames) {
    const patchFile = join(profilesDir, name, 'cordis.patch.yml')
    if (!existsSync(patchFile)) continue
    try {
      if (idPattern.test(readFileSync(patchFile, 'utf8'))) return patchFile
    } catch {
      // unreadable patch file: skip
    }
  }
  return undefined
}

/** Fields of the host plugin manager's change result read here. */
export interface PluginChangeView {
  readonly application: string
  readonly error?: { readonly code: string; readonly diagnostic?: string }
}

const MANAGEMENT_ERRORS: Readonly<Record<string, string>> = {
  'unaddressable': 'this entry cannot be changed through the profile patch (declared inside a group or under a duplicate id)',
  'management-required': 'this entry is required by plugin management and cannot be disabled',
  'unknown-plugin': 'the plugin manager does not know this entry',
}

/** Map a plugin manager change result to the Remote result. */
export function changeOutcome(result: PluginChangeView): McpApplyResult {
  if (result.application === 'applied' && result.error === undefined) return { ok: true }
  if (result.application === 'restart-required') return { ok: false, error: 'saved; restart dsh to apply' }
  if (result.application === 'overridden') return { ok: false, error: 'saved, but a higher-priority patch overrides it' }
  const error = result.error
  if (error === undefined) return { ok: false, error: `plugin manager reported ${result.application}` }
  return { ok: false, error: MANAGEMENT_ERRORS[error.code] ?? (error.diagnostic === undefined ? error.code : `${error.code}: ${error.diagnostic}`) }
}

function defaultProfilesDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')
}
