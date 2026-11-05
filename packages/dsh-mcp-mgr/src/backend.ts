/** Adapt the stock MCP client's registrations without duplicating its connection supervisor. */
import type { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { AgentBindingHandle, SharedMountHandle } from './mounts.ts'
import { toolKey } from './restrict.ts'

type Undo = () => void
interface Registration {
  readonly tool: string | undefined
  install(ctx: Context): Undo
}
interface Subscriber {
  readonly ctx: Context
  exclude: ReadonlySet<string>
  readonly installed: Map<Registration, Undo>
}
interface FiberView {
  await(): Promise<unknown>
  dispose(): unknown
  readonly inertia?: Promise<unknown>
}
interface RegistrationService {
  [method: string]: (...args: unknown[]) => Undo
}

class Registrations {
  private readonly entries = new Set<Registration>()
  private readonly subscribers = new Set<Subscriber>()

  constructor(private readonly server: string, private readonly seen: (tool: string) => void) {}

  capture(ctx: Context, service: string, method: string, args: unknown[]): Undo {
    const definition = args[0] as { name?: string }
    const tool = service === 'tools' && typeof definition.name === 'string' ? toolKey(this.server, definition.name) : undefined
    if (tool !== undefined) this.seen(tool)
    const entry: Registration = {
      tool,
      install: target => {
        const api = target.get(service) as RegistrationService | undefined
        if (api === undefined) throw new Error(`mcp-mgr: ${service} service unavailable for ${this.server}`)
        const register = api[method]
        if (register === undefined) throw new Error(`mcp-mgr: ${service}.${method} unavailable`)
        return register.call(api, ...args)
      },
    }
    return ctx.effect(() => {
      this.entries.add(entry)
      for (const subscriber of this.subscribers) this.install(subscriber, entry)
      return () => { this.remove(entry) }
    }, `mcp-mgr: shared ${service}.${method}`) as Undo
  }

  bind(ctx: Context, exclude: ReadonlySet<string>): AgentBindingHandle {
    const subscriber: Subscriber = { ctx, exclude, installed: new Map() }
    try {
      for (const entry of this.entries) this.install(subscriber, entry)
    } catch (error) {
      this.clear(subscriber)
      throw error
    }
    this.subscribers.add(subscriber)
    let disposed = false
    return {
      update: next => {
        if (disposed) return false
        subscriber.exclude = next
        let changed = false
        for (const entry of this.entries) {
          if (entry.tool !== undefined && next.has(entry.tool)) {
            if (subscriber.installed.has(entry)) {
              subscriber.installed.get(entry)?.()
              subscriber.installed.delete(entry)
              changed = true
            }
          } else changed = this.install(subscriber, entry) || changed
        }
        return changed
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        this.subscribers.delete(subscriber)
        this.clear(subscriber)
      },
    }
  }

  private install(subscriber: Subscriber, entry: Registration): boolean {
    if (subscriber.installed.has(entry) || (entry.tool !== undefined && subscriber.exclude.has(entry.tool))) return false
    try {
      subscriber.installed.set(entry, entry.install(subscriber.ctx))
      return true
    } catch (error) {
      subscriber.ctx.logger.warn(`mcp-mgr(${this.server}): agent binding ${entry.tool ?? 'context'} failed: ${String(error)}`)
      return false
    }
  }

  private remove(entry: Registration): void {
    this.entries.delete(entry)
    for (const subscriber of this.subscribers) {
      subscriber.installed.get(entry)?.()
      subscriber.installed.delete(entry)
    }
  }

  private clear(subscriber: Subscriber): void {
    for (const undo of subscriber.installed.values()) undo()
    subscriber.installed.clear()
  }

  /** Injection callbacks receive a new context, so carry the facade into those too. */
  facade(ctx: Context): Context {
    const intercepted: Record<string, string> = { tools: 'register', mcpResources: 'register', systemPrompt: 'section' }
    return new Proxy(ctx, {
      get: (target, key, receiver) => {
        if (key === 'inject') {
          return (dependencies: string[], callback: (inner: Context) => unknown) =>
            target.inject(dependencies, inner => callback(this.facade(inner)))
        }
        if (typeof key === 'string' && key in intercepted) {
          const api = Reflect.get(target, key, receiver) as object
          return new Proxy(api, {
            get: (service, method) => {
              if (method === intercepted[key]) return (...args: unknown[]) => this.capture(target, key, String(method), args)
              const value = Reflect.get(service, method)
              return typeof value === 'function' ? value.bind(service) : value
            },
          })
        }
        return Reflect.get(target, key, receiver)
      },
    })
  }
}

export function openSharedServer(ctx: Context, config: McpClientConfig, seen: (tool: string) => void): SharedMountHandle {
  // A private scope reserves the namespace without making any registration global.
  const scope = createScope(ctx, {})
  const registrations = new Registrations(config.serverName, seen)
  const fiber = scope.ctx.plugin({
    name: mcpClient.name,
    inject: mcpClient.inject,
    apply: async (pluginCtx: Context, resolved: McpClientConfig) => mcpClient.apply(registrations.facade(pluginCtx), resolved),
  }, config) as unknown as FiberView
  let stopping: Promise<void> | undefined
  return {
    ready: fiber.await().then(() => undefined),
    bind: (agent, exclude) => {
      const bindingScope = createScope(ctx, agent)
      let binding: AgentBindingHandle
      try {
        binding = registrations.bind(bindingScope.ctx, exclude)
      } catch (error) {
        void bindingScope.dispose()
        throw error
      }
      return {
        update: next => binding.update(next),
        dispose: async () => {
          await binding.dispose()
          await bindingScope.dispose()
        },
      }
    },
    dispose: () => stopping ??= (async () => {
      await fiber.dispose()
      while (fiber.inertia !== undefined) await fiber.inertia
      await scope.dispose()
    })(),
  }
}
