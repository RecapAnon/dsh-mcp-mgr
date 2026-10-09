/**
 * MCP manager tab registered into Web Settings.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT_REMOTE } from 'dsh-mcp-mgr/remote'
import type { McpApplyResult, McpManagerSnapshot, McpPluginVersionInfo, McpServerDraft } from 'dsh-mcp-mgr/types'
import { McpSettingsTab, type McpSettingsTabInjected } from './McpSettingsTab.tsx'
import { en, zh, type McpLocaleKey } from './locales.ts'

export type { McpSettingsTabInjected, McpSettingsTabProps } from './McpSettingsTab.tsx'
export type { McpLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP manager copy. */
    'settings.mcpMgr': McpLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcpMgr'

/** Services required by the Settings registration. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces']

/** The namespace service this plugin mounts itself — fetched via `ctx.get`, never injected. */
interface McpMgrNamespace {
  snapshot(): Promise<RemoteResult<McpManagerSnapshot>>
  apply(draft: McpServerDraft): Promise<RemoteResult<McpApplyResult>>
  removeServer(workspace: string, name: string): Promise<RemoteResult<McpApplyResult>>
  setServerEnabled(workspace: string, name: string, enabled: boolean): Promise<RemoteResult<McpApplyResult>>
  versionInfo(): Promise<RemoteResult<McpPluginVersionInfo>>
}

/**
 * Mount the mcpMgr Remote contribution and register the tab into the
 * Plugins settings section.
 *
 * The mount is awaited in `apply` (the api-remotes pattern) so the tab is
 * only registered after the namespace service exists. The namespace is not
 * injected: this plugin provides it itself, and injecting a self-provided
 * service deadlocks the fiber (pending forever). Consumers read it through
 * `ctx.get`, which bypasses the inject guard.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const disposeMount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => () => disposeMount(), 'dsh-mcp-mgr-ui: remote mount')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp-mgr-ui: dictionaries')

  const t = ctx.locale.bind(NS)
  const mcpMgr = (): McpMgrNamespace => {
    const namespace = ctx.get('remote.mcpMgr') as McpMgrNamespace | undefined
    if (namespace === undefined) {
      throw new Error('mcpMgr namespace service is not mounted')
    }
    return namespace
  }

  const currentSession = () => Object.values(ctx.sessions.list.getSnapshot().byId)
    .find(row => (row.retainedBy.mainView ?? 0) > 0)?.id

  const injected = (): McpSettingsTabInjected => ({
    snapshot: async () => {
      const result = await mcpMgr().snapshot()
      if (!result.ok) {
        throw new Error(`mcpMgr.snapshot failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    },
    apply: async (draft) => {
      const result = await mcpMgr().apply(draft)
      if (!result.ok) {
        throw new Error(`mcpMgr.apply failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    },
    removeServer: async (workspace, name) => {
      const result = await mcpMgr().removeServer(workspace, name)
      if (!result.ok) {
        throw new Error(`mcpMgr.removeServer failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    },
    setServerEnabled: async (workspace, name, enabled) => {
      const result = await mcpMgr().setServerEnabled(workspace, name, enabled)
      if (!result.ok) {
        throw new Error(`mcpMgr.setServerEnabled failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    },
    versionInfo: async () => {
      const result = await mcpMgr().versionInfo()
      if (!result.ok) {
        throw new Error(`mcpMgr.versionInfo failed: ${result.error.code}: ${result.error.message}`)
      }
      return result.value
    },
    listWorkspaces: () => ctx.workspaces.list.getSnapshot().items.map(workspace => ({
      path: workspace.path,
      title: workspace.title,
    })),
    currentWorkspacePath: () => {
      const current = currentSession()
      if (current === undefined) return ''
      return ctx.workspaces.list.getSnapshot().items
        .find(workspace => workspace.sessionIds.includes(current))?.path ?? ''
    },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'mcpMgr',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, McpSettingsTab))
}
