/**
 * Compile-time stub of `@deepseek-ai/dsh-scope`.
 *
 * Only the members used here are declared; the real package is resolved at
 * runtime through the host app's node_modules. Kept minimal so the Typert
 * analysis program never drags the real d.ts chain in.
 */
declare module '@deepseek-ai/dsh-scope' {
  import type { Context } from '@deepseek-ai/cordis'
  export type ScopeKey = object
  /** A minted registration scope. */
  export interface Scope {
    ctx: Context
    dispose(): Promise<void>
  }
  /** Mint a scope under `ctx` whose registrations are tagged with `key`. */
  export function createScope(ctx: Context, key: ScopeKey): Scope
  /** Read the nearest scope tag inherited by a context. */
  export function scopeOf(ctx: unknown): ScopeKey | undefined
}
