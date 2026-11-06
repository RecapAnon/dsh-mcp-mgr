import { useState, type ReactNode } from 'react'
import type { McpServerState } from 'dsh-mcp-mgr/types'
import type { McpLocaleKey } from './locales.ts'
import css from './McpPage.module.css'

export interface ToolPickerProps {
  readonly server: McpServerState
  readonly busy: boolean
  readonly t: (key: McpLocaleKey) => string
  /** Persist the excluded tool names. */
  readonly save: (excluded: readonly string[]) => void
  readonly close: () => void
}

/** Per-tool checkboxes of one server; checked = visible to agents. */
export function ToolPicker({ server, busy, t, save, close }: ToolPickerProps): ReactNode {
  const tools = server.tools ?? []
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set(server.excludedTools ?? []))
  const toggle = (tool: string): void => {
    setExcluded((current) => {
      const next = new Set(current)
      if (next.has(tool)) next.delete(tool)
      else next.add(tool)
      return next
    })
  }
  return (
    <div className={css.toolPicker}>
      <p className={css.toolHint}>{server.source === 'workspace' ? t('toolsHintWorkspace') : t('toolsHintProfile')}</p>
      {tools.length === 0 ? <p className={css.toolHint}>{t('toolsUnknown')}</p> : (
        <>
          <div className={css.toolActions}>
            <button type="button" className={css.toggle} disabled={busy} onClick={() => { setExcluded(new Set()) }}>{t('toolsAll')}</button>
            <button type="button" className={css.toggle} disabled={busy} onClick={() => { setExcluded(new Set(tools)) }}>{t('toolsNone')}</button>
          </div>
          <div className={css.toolGrid}>
            {tools.map(tool => (
              <label key={tool} className={css.toolItem} title={tool}>
                <input type="checkbox" checked={!excluded.has(tool)} disabled={busy} onChange={() => { toggle(tool) }} />
                <span>{tool}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className={css.toolActions}>
        <button type="button" className={css.add} disabled={busy || tools.length === 0} onClick={() => { save([...excluded].sort()) }}>{t('save')}</button>
        <button type="button" className={css.toggle} disabled={busy} onClick={close}>{t('cancel')}</button>
      </div>
    </div>
  )
}
