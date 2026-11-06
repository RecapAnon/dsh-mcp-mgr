import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { McpApplyResult, McpManagerSnapshot, McpPluginVersionInfo, McpServerDraft, McpServerState, McpServerStatus } from 'dsh-mcp-mgr/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { McpServerForm } from './McpServerForm.tsx'
import { ToolPicker } from './ToolPicker.tsx'
import type { McpLocaleKey } from './locales.ts'
import css from './McpPage.module.css'

/** One workspace row the add-form may target. */
export interface WorkspaceOption {
  readonly path: string
  readonly title: string
}

/** Registration-side Remote face used by the page. */
export interface McpPageInjected {
  /** Read a current manager snapshot. */
  snapshot: () => Promise<McpManagerSnapshot>
  /** Create one server entry in a workspace's mcp.json. */
  apply: (draft: McpServerDraft) => Promise<McpApplyResult>
  /** Remove one server from a workspace's mcp.json. */
  removeServer: (workspace: string, name: string) => Promise<McpApplyResult>
  /** Enable/disable one server in a workspace's mcp.json. */
  setServerEnabled: (workspace: string, name: string, enabled: boolean) => Promise<McpApplyResult>
  /** Enable/disable one profile-level server through the host plugin manager. */
  setProfileServerEnabled: (entryId: string, enabled: boolean) => Promise<McpApplyResult>
  /** Set the tools of one workspace server hidden from agents. */
  setServerTools: (workspace: string, name: string, excludeTools: readonly string[]) => Promise<McpApplyResult>
  /** Set the tools of one profile-level server hidden from agents. */
  setProfileServerTools: (name: string, excludeTools: readonly string[]) => Promise<McpApplyResult>
  /** Self-update check result (startup npm lookup). */
  versionInfo: () => Promise<McpPluginVersionInfo>
  /** Registered workspaces for the add-form target picker. */
  listWorkspaces: () => readonly WorkspaceOption[]
  /** Workspace of the currently open session ('' when none). */
  currentWorkspacePath: () => string
}

/** Full component props assembled by the main-panel slot renderer. */
export type McpPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'mcpMgr'>
  & InjectFace<McpPageInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: McpManagerSnapshot }

/** Badge label key per row status. */
const STATUS_KEYS = {
  active: 'active',
  error: 'errorStatus',
  conflict: 'conflict',
  configured: 'configured',
  disabled: 'disabled',
} satisfies Record<McpServerStatus, McpLocaleKey>

/**
 * Short display form of a source path: last path segment by default, last two
 * when `forceLastTwo` (used for profile config files and colliding basenames).
 */
function shortPath(path: string, forceLastTwo = false): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return path
  const count = forceLastTwo && parts.length > 2 ? 2 : 1
  return parts.slice(-count).join('/')
}

/** Sidebar row glyph: a two-prong plug, drawn in currentColor at the requested edge. */
export function McpPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3v4M15 3v4M6 7h12v3a6 6 0 0 1-12 0V7ZM12 16v5" />
    </svg>
  )
}

/** Main-panel page listing the registered MCP servers (workspace + profile sources). */
export function McpPage({
  snapshot, apply, removeServer, setServerEnabled, setProfileServerEnabled, setServerTools, setProfileServerTools,
  versionInfo, listWorkspaces, currentWorkspacePath, t,
}: McpPageProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [updateInfo, setUpdateInfo] = useState<McpPluginVersionInfo | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [toolsOpen, setToolsOpen] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void versionInfo().then(
      (info) => { if (current) setUpdateInfo(info) },
      () => { if (current) setUpdateInfo(null) },
    )
    return () => { current = false }
  }, [versionInfo])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => snapshot()).then(
      (value) => { if (current) { setState({ status: 'ready', snapshot: value }); setErrorDetail(null) } },
      (error) => {
        if (current) {
          setState({ status: 'error' })
          setErrorDetail(String(error instanceof Error ? error.message : error))
        }
      },
    )
    return () => { current = false }
  }, [snapshot, request])

  const servers = useMemo(
    () => state.status === 'ready' ? state.snapshot.servers : [],
    [state],
  )

  /** Source-cell display paths with basename collisions widened to two segments. */
  const sourceDisplay = useMemo(() => {
    const workspaceBasenames = new Map<string, number>()
    for (const server of servers) {
      if (server.source !== 'workspace' || server.workspace === undefined) continue
      const base = shortPath(server.workspace)
      workspaceBasenames.set(base, (workspaceBasenames.get(base) ?? 0) + 1)
    }
    return new Map(servers.map(server => [
      server.key,
      server.source === 'workspace' && server.workspace !== undefined
        ? shortPath(server.workspace, (workspaceBasenames.get(shortPath(server.workspace)) ?? 0) > 1)
        : shortPath(server.sourceFile ?? server.key, true),
    ]))
  }, [servers])

  const retry = (): void => {
    setNotice(null)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const onRemove = async (server: McpServerState): Promise<void> => {
    if (server.workspace === undefined) return
    setBusy(server.key)
    setNotice(null)
    let result: McpApplyResult
    try {
      result = await removeServer(server.workspace, server.name)
    } catch (error) {
      setBusy(null)
      setNotice(`${t('applyFailed')}: ${String(error instanceof Error ? error.message : error)}`)
      return
    }
    setBusy(null)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
    setNotice(result.ok ? t('removed') : `${t('applyFailed')}: ${result.error}`)
  }

  const onAdded = (_workspace: string): void => {
    setShowForm(false)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
    setNotice(t('added'))
  }

  const onToggleEnabled = async (server: McpServerState, enabled: boolean): Promise<void> => {
    const { workspace, entryId } = server
    const toggle = server.source === 'workspace'
      ? workspace === undefined ? undefined : () => setServerEnabled(workspace, server.name, enabled)
      : entryId === undefined ? undefined : () => setProfileServerEnabled(entryId, enabled)
    if (toggle === undefined) return
    setBusy(server.key)
    setNotice(null)
    let result: McpApplyResult
    try {
      result = await toggle()
    } catch (error) {
      setBusy(null)
      setNotice(`${t('applyFailed')}: ${String(error instanceof Error ? error.message : error)}`)
      return
    }
    setBusy(null)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
    setNotice(result.ok ? (enabled ? t('enabled') : t('disabled')) : `${t('applyFailed')}: ${result.error}`)
  }

  const onSaveTools = async (server: McpServerState, excluded: readonly string[]): Promise<void> => {
    const { workspace } = server
    if (server.source === 'workspace' && workspace === undefined) return
    setBusy(server.key)
    setNotice(null)
    let result: McpApplyResult
    try {
      result = server.source === 'workspace' && workspace !== undefined
        ? await setServerTools(workspace, server.name, excluded)
        : await setProfileServerTools(server.name, excluded)
    } catch (error) {
      setBusy(null)
      setNotice(`${t('applyFailed')}: ${String(error instanceof Error ? error.message : error)}`)
      return
    }
    setBusy(null)
    if (result.ok) setToolsOpen(null)
    setState({ status: 'loading' })
    setRequest(value => value + 1)
    setNotice(result.ok ? t('toolsSaved') : `${t('applyFailed')}: ${result.error}`)
  }

  return (
    <div className={css.page}>
    <div className={css.pageScroll}>
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {/* Transient result feedback: floats over the viewport, never pushes the table. */}
      {notice !== null ? <Toast text={notice} onDone={() => { setNotice(null) }} /> : null}
      <div className={css.heading}>
        <h1>{t('title')}</h1>
        <div className={css.headingActions}>
          <button
            type="button"
            className={css.add}
            disabled={listWorkspaces().length === 0}
            title={t('noWorkspace')}
            onClick={() => { setShowForm(true) }}
          >
            {t('add')}
          </button>
          <button type="button" className={css.refresh} onClick={retry}>{t('refresh')}</button>
        </div>
      </div>
      <p className={css.intro}>{t('intro')}</p>
      {/* Startup npm update check: banner only when an upgrade is available. */}
      {updateInfo?.updateAvailable === true ? (
        <div className={css.update} role="status">
          {t('updateAvailable')}
          {' '}
          <a href={updateInfo.updateUrl} target="_blank" rel="noreferrer">{updateInfo.updateUrl}</a>
          {' '}
          {t('updateAvailableLink')}
        </div>
      ) : null}
      {showForm ? (
        <McpServerForm
          workspaces={listWorkspaces()}
          defaultWorkspace={currentWorkspacePath()}
          submit={apply}
          t={t}
          onClose={() => { setShowForm(false) }}
          onAdded={onAdded}
        />
      ) : null}
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          {errorDetail !== null ? <p className={css.errorText} role="alert">{errorDetail}</p> : null}
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' && servers.length === 0
        ? <p className={css.status}>{t('empty')}</p>
        : null}
      {servers.length > 0 ? (
        <table className={css.table}>
          <thead>
            <tr>
              <th>{t('source')}</th>
              <th>{t('server')}</th>
              <th>{t('transport')}</th>
              <th>{t('status')}</th>
              <th title={t('agentsHint')}>{t('agents')}</th>
              <th>{t('action')}</th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => {
              const fullPath = server.source === 'workspace' ? server.workspace : server.sourceFile
              const toolCount = server.tools === undefined
                ? ''
                : ` ${server.tools.length - (server.excludedTools?.length ?? 0)}/${server.tools.length}`
              const toolsButton = server.status === 'error' && server.transport === undefined ? null : (
                <button
                  type="button"
                  className={css.toggle}
                  aria-expanded={toolsOpen === server.key}
                  disabled={busy === server.key}
                  title={t('toolsHint')}
                  onClick={() => { setToolsOpen(open => open === server.key ? null : server.key) }}
                >
                  {`${t('tools')}${toolCount}`}
                </button>
              )
              return (
                <Fragment key={server.key}>
                <tr data-source={server.source}>
                  <td className={css.sourceCell}>
                    {fullPath !== undefined
                      ? <span className={css.sourcePath} title={fullPath}>{sourceDisplay.get(server.key)}</span>
                      : null}
                  </td>
                  <td className={css.nowrapCell} title={server.name}>{server.name}</td>
                  <td className={css.nowrapCell} title={server.transport}>{server.transport ?? ''}</td>
                  <td className={css.nowrapCell}>
                    <span className={css.statusBadge} data-status={server.status}>
                      {t(STATUS_KEYS[server.status])}
                    </span>
                    {(server.error ?? server.lastError) !== undefined ? (
                      <span className={css.errorText} title={server.error ?? server.lastError}>
                        {server.error ?? server.lastError}
                      </span>
                    ) : null}
                  </td>
                  <td className={css.nowrapCell}>
                    {server.source === 'workspace' ? (
                      <span title={t('agentsHint')}>
                        {`${t('liveAgents')} ${server.liveAgents ?? 0} · ${t('connectedAgents')} ${server.connectedAgents ?? 0}`}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <div className={css.actionCell}>
                    {toolsButton}
                    {server.source === 'workspace' ? (
                      <>
                        <button
                          type="button"
                          className={css.toggle}
                          disabled={busy === server.key}
                          onClick={() => { void onToggleEnabled(server, server.enabled === false) }}
                        >
                          {server.enabled === false ? t('enable') : t('disable')}
                        </button>
                        <button
                          type="button"
                          className={css.danger}
                          disabled={busy === server.key}
                          onClick={() => { void onRemove(server) }}
                        >
                          {t('remove')}
                        </button>
                      </>
                    ) : server.entryId !== undefined ? (
                      <button
                        type="button"
                        className={css.toggle}
                        disabled={busy === server.key}
                        title={t('profileToggleHint')}
                        onClick={() => { void onToggleEnabled(server, server.enabled === false) }}
                      >
                        {server.enabled === false ? t('enable') : t('disable')}
                      </button>
                    ) : null}
                    </div>
                  </td>
                </tr>
                {toolsOpen === server.key ? (
                  <tr data-source={server.source}>
                    <td colSpan={6}>
                      <ToolPicker
                        server={server}
                        busy={busy === server.key}
                        t={t}
                        save={(excluded) => { void onSaveTools(server, excluded) }}
                        close={() => { setToolsOpen(null) }}
                      />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      ) : null}
    </div>
    </div>
    </div>
  )
}
