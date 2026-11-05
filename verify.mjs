/**
 * dsh-mcp-mgr verification with a fake host:
 *  1. parse mcp.json documents (incl. ${VAR} expansion and rejections)
 *  2. pooled mounts: shared startup, agent bindings, wait cap, abort, warm lifetime, config changes, failures; workspace resolution
 *  3. Remote artifact shape (strict codecs) and strict-mode removal
 *  4. real Typert registry mount of the generated contribution
 */
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parseMcpJson, expandEnv } from './packages/dsh-mcp-mgr/lib/types/parse.js'
import { AgentMounts } from './packages/dsh-mcp-mgr/lib/types/mounts.js'

const root = dirname(fileURLToPath(import.meta.url))
let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok: ${label}`)
  else { failures += 1; console.error(`  FAIL: ${label} ${detail}`) }
}

// ── 1. parse ────────────────────────────────────────────────────────────────
console.log('parse:')
{
  const doc = JSON.stringify({
    mcpServers: {
      memory: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-memory'], env: { TOKEN: '${MCP_TEST_TOKEN}' }, cwd: '/tmp/srv' },
      web: { type: 'http', url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer x' } },
      off: { type: 'stdio', command: 'npx', enabled: false },
      'bad.name': { command: 'x' },
      missingCmd: { type: 'stdio' },
      brokenEnv: { type: 'stdio', command: 'x', env: { K: '${MCP_TEST_MISSING_VAR}' } },
      trimmed: { type: 'http', url: 'http://x/mcp', excludeTools: ['pdf', 'html', 'pdf'] },
      badTools: { type: 'http', url: 'http://x/mcp', excludeTools: 'pdf' },
      isolated: { type: 'stdio', command: 'node', scope: 'agent' },
      shared: { type: 'http', url: 'http://x/mcp', scope: 'workspace' },
      badScope: { type: 'stdio', command: 'node', scope: 'global' },
      nullScope: { type: 'stdio', command: 'node', scope: null },
    },
  })
  process.env.MCP_TEST_TOKEN = 'tok-123'
  const parsed = parseMcpJson(doc, '/ws/a')
  check('stdio mapped with expansion', parsed.servers.some(s => s.name === 'memory' && s.config.transport === 'stdio' && s.config.env.TOKEN === 'tok-123' && s.config.cwd === '/tmp/srv'))
  check('http mapped', parsed.servers.some(s => s.name === 'web' && s.config.transport === 'streamable-http' && s.config.headers.Authorization === 'Bearer x'))
  const stdio = parsed.servers.find(s => s.name === 'memory')
  check('stdio cwd explicit wins', stdio?.config.cwd === '/tmp/srv')
  const http = parsed.servers.find(s => s.name === 'web')
  check('http config shape', http !== undefined && http.config.cwd === undefined)
  check('bad name rejected', parsed.errors.some(e => e.name === 'bad.name'))
  check('missing command rejected', parsed.errors.some(e => e.name === 'missingCmd'))
  check('missing env rejected', parsed.errors.some(e => e.name === 'brokenEnv'))
  check('enabled defaults true when absent', parsed.servers.find(s => s.name === 'memory')?.enabled === true)
  check('explicit enabled:false parsed', parsed.servers.find(s => s.name === 'off')?.enabled === false)
  check('expandEnv literal passthrough', expandEnv('hello', 'x').ok && expandEnv('hello', 'x').value === 'hello')
  check('excludeTools parsed sorted and de-duplicated', parsed.servers.find(s => s.name === 'trimmed')?.excludeTools.join() === 'html,pdf')
  check('excludeTools defaults to empty', parsed.servers.find(s => s.name === 'memory')?.excludeTools.length === 0)
  check('non-array excludeTools rejected', parsed.errors.some(e => e.name === 'badTools'))
  check('agent mounts fail on startup error', parsed.servers.every(s => s.config.failOnStartupError === true))
  check('workspace sharing is the parser default', parsed.servers.find(s => s.name === 'memory')?.scope === 'workspace')
  check('explicit agent and workspace scopes are retained', parsed.servers.find(s => s.name === 'isolated')?.scope === 'agent' && parsed.servers.find(s => s.name === 'shared')?.scope === 'workspace')
  check('unknown and null scopes are rejected', ['badScope', 'nullScope'].every(name => parsed.errors.some(e => e.name === name)))
  delete process.env.MCP_TEST_TOKEN
}

// ── 2. pooled mounts (fake host) ────────────────────────────────────────────
console.log('pooled mounts:')
{
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const deferred = () => {
    let resolve
    const promise = new Promise(done => { resolve = done })
    return { promise, resolve }
  }
  const srv = (name, extra = {}) => ({
    name, enabled: extra.enabled ?? true, excludeTools: extra.excludeTools ?? [],
    ...(extra.scope === undefined ? {} : { scope: extra.scope }),
    config: { transport: 'stdio', serverName: name, command: extra.command ?? 'x', args: [], env: {}, cwd: extra.cwd ?? '/ws', toolCallTimeoutMs: 60000, failOnStartupError: true },
  })
  function harness(options = {}) {
    const h = {
      config: options.config ?? {}, reserved: new Set(options.reserved ?? []),
      hang: new Set(options.hang ?? []), fail: new Map(Object.entries(options.fail ?? {})),
      backends: [], bindings: [], warnings: [], seen: [],
    }
    h.see = agent => h.bindings.filter(b => b.agent === agent && !b.disposed && b.backend.connected && !b.backend.disposed).map(b => b.backend.name).sort()
    h.binding = (agent, name) => h.bindings.findLast(b => b.agent === agent && b.backend.name === name && !b.disposed)
    h.open = name => {
      h.hang.delete(name)
      for (const backend of h.backends.filter(b => b.name === name)) backend.gate.resolve()
    }
    h.live = () => h.backends.filter(b => !b.disposed)
    h.host = {
      workspaceOf: agent => (agent.cwd in h.config ? agent.cwd : undefined),
      candidates: ws => (h.config[ws] ?? []).filter(s => s.enabled && !h.reserved.has(s.name)),
      openServer: (config, seen) => {
        const backend = { name: config.serverName, config, gate: deferred(), connected: false, disposed: false, disposeCalls: 0, counter: 0 }
        h.backends.push(backend)
        if (!h.hang.has(backend.name)) backend.gate.resolve()
        const ready = backend.gate.promise.then(() => {
          if (backend.disposed) return
          if (h.fail.has(backend.name)) throw new Error(h.fail.get(backend.name))
          backend.connected = true
          seen('t1')
          seen('t2')
        })
        return {
          ready,
          bind: (agent, exclude) => {
            const binding = { agent, backend, exclude: new Set(exclude), updates: 0, disposed: false, disposeCalls: 0 }
            h.bindings.push(binding)
            // A small request proxy proves bindings share backend state, not just a startup count.
            binding.call = async (gate = Promise.resolve()) => {
              await gate
              if (binding.disposed || backend.disposed || !backend.connected) throw new Error('disconnected')
              return ++backend.counter
            }
            return {
              update: next => {
                if ([...next].sort().join() !== [...binding.exclude].sort().join()) binding.updates += 1
                binding.exclude = new Set(next)
              },
              dispose: async () => { binding.disposeCalls += 1; binding.disposed = true },
            }
          },
          dispose: async () => {
            backend.disposeCalls += 1
            await backend.disposeGate?.promise
            backend.disposed = true
            backend.connected = false
            backend.gate.resolve()
          },
        }
      },
      onAgentDispose: (agent, release) => (agent.inactive ? undefined : (agent.dispose = release, () => { agent.unhooked = true })),
      isIdle: agent => agent.status !== 'running',
      toolSeen: (ws, server, tool) => { h.seen.push(`${ws}#${server}:${tool}`) },
      warn: message => { h.warnings.push(message) },
    }
    h.mounts = new AgentMounts(h.host, { idleTimeoutMs: options.idleTimeoutMs ?? 60000, mountWaitMs: options.mountWaitMs ?? 500 })
    return h
  }
  const agent = (id, cwd, preset = 'coder') => ({ id, cwd, preset, status: 'running' })
  const newActivity = (h, a) => { h.mounts.status(a, 'idle'); h.mounts.status(a, 'running') }

  // The pool key includes the workspace even when the complete configs are identical.
  {
    const h = harness({ config: { '/A': [srv('graphiti'), srv('onlyA')], '/B': [srv('graphiti'), srv('onlyB')] } })
    const a = agent('a', '/A'), sub = agent('sub', '/A'), b = agent('b', '/B')
    check('first turn reports fresh registrations', await h.mounts.turn(a))
    await h.mounts.turn(sub)
    await h.mounts.turn(b)
    check('workspace A agents see only A servers', h.see(a).join() === 'graphiti,onlyA' && h.see(sub).join() === 'graphiti,onlyA')
    check('workspace B sees only B servers', h.see(b).join() === 'graphiti,onlyB')
    const ba = h.binding(a, 'graphiti'), bs = h.binding(sub, 'graphiti'), bb = h.binding(b, 'graphiti')
    check('same workspace and ID reuse one backend by default', ba?.backend === bs?.backend && h.backends.length === 4)
    check('same ID and identical config in another workspace remain separate', ba?.backend !== bb?.backend && h.backends.filter(x => x.name === 'graphiti').length === 2)
    check('agentsIn and liveAgents retain per-workspace binding counts', h.mounts.agentsIn('/A').includes(a) && h.mounts.agentsIn('/A').includes(sub) && !h.mounts.agentsIn('/A').includes(b) && h.mounts.liveAgents('/A', 'graphiti') === 2 && h.mounts.liveAgents('/B', 'graphiti') === 1)
    check('unchanged turn does not change registrations or start servers', !(await h.mounts.turn(a)) && h.backends.length === 4)
    const request = deferred()
    const first = ba.call(request.promise), second = bs.call()
    check('shared request proxy reaches one stateful backend', await second === 1)
    request.resolve()
    check('concurrent proxy requests keep their own result and workspace state', await first === 2 && await bb.call() === 1)
    await h.mounts.workspaceRemoved('/A')
    check('removing one workspace never stops the same server ID in another', ba.backend.disposed && !bb.backend.disposed && h.see(a).length === 0 && h.see(b).join() === 'graphiti,onlyB')
    await h.mounts.dispose()
    check('unload removes every binding and backend exactly once', h.see(a).length === 0 && h.see(b).length === 0 && h.bindings.every(x => x.disposed && x.disposeCalls === 1) && h.backends.every(x => x.disposed && x.disposeCalls === 1))
  }

  // Explicit workspace scope shares; agent scope preserves isolated server state.
  {
    const h = harness({ config: { '/A': [srv('shared', { scope: 'workspace' }), srv('private', { scope: 'agent' })] } })
    const a = agent('a', '/A'), b = agent('b', '/A')
    await Promise.all([h.mounts.turn(a), h.mounts.turn(b)])
    const shared = h.binding(a, 'shared').backend
    const privateA = h.binding(a, 'private').backend, privateB = h.binding(b, 'private').backend
    check('explicit workspace scope shares, agent scope starts separate backends', shared === h.binding(b, 'shared').backend && privateA !== privateB && h.backends.length === 3)
    check('agent-scoped request state is independent', await h.binding(a, 'private').call() === 1 && await h.binding(b, 'private').call() === 1)
    await a.dispose()
    check('agent disposal removes its bindings and only its private backend', h.see(a).length === 0 && privateA.disposed && !privateB.disposed && !shared.disposed && h.see(b).join() === 'private,shared')
    await h.mounts.release(b)
    check('last release retains shared backend but stops private backend', privateB.disposed && !shared.disposed && h.mounts.liveAgents('/A', 'shared') === 0 && !h.mounts.agentsIn('/A').includes(b))
    const later = agent('later', '/A')
    await h.mounts.turn(later)
    check('later session reuses warm shared server without another startup', h.binding(later, 'shared').backend === shared && h.backends.filter(x => x.name === 'shared').length === 1)
    await h.mounts.dispose()
    check('plugin unload cleans warm and private backends', h.live().length === 0)
  }

  // Startup is gated before readiness: simultaneous agents must join one pending backend.
  {
    const h = harness({ config: { '/A': [srv('slow')] }, hang: ['slow'], mountWaitMs: 5000 })
    const a = agent('a', '/A'), b = agent('b', '/A')
    const controller = new AbortController()
    const first = h.mounts.turn(a, controller.signal)
    const duplicate = h.mounts.turn(a)
    const second = h.mounts.turn(b)
    let secondDone = false
    void second.then(() => { secondDone = true })
    await flush()
    check('simultaneous agents and duplicate assemblies share one pending startup', h.backends.length === 1 && !secondDone && h.see(a).length === 0 && h.see(b).length === 0)
    controller.abort()
    await first
    check('one aborted waiter does not dispose startup or finish another waiter', h.live().length === 1 && !secondDone)
    h.open('slow')
    await Promise.all([duplicate, second])
    check('remaining waiters bind to the same completed server', h.see(a).join() === 'slow' && h.see(b).join() === 'slow' && h.binding(a, 'slow').backend === h.binding(b, 'slow').backend && h.backends.length === 1)
    check('concurrent assemblies do not duplicate one agent binding', h.bindings.filter(x => x.agent === a && !x.disposed).length === 1)
    check('discovery is attributed to the workspace once', h.seen.filter(x => x === '/A#slow:t1').length === 1)
    await h.mounts.dispose()
  }

  // Only bounded-wait assertions need a real timer; all startup ordering uses explicit gates.
  {
    const h = harness({ config: { '/A': [srv('ok'), srv('slow')] }, hang: ['slow'], mountWaitMs: 60 })
    const a = agent('a', '/A')
    const start = Date.now()
    const changed = await h.mounts.turn(a)
    const elapsed = Date.now() - start
    check('wait budget ends while a slow server remains pending', elapsed >= 40 && elapsed < 1500 && changed && h.see(a).join() === 'ok' && !h.backends.find(x => x.name === 'slow').connected, `elapsed ${elapsed}`)
    const next = h.mounts.turn(a)
    let immediate = false
    void next.then(() => { immediate = true })
    await flush()
    check('later step in the same activity does not receive a fresh wait budget', immediate)
    await next
    newActivity(h, a)
    let renewedDone = false
    const renewed = h.mounts.turn(a).then(() => { renewedDone = true })
    await flush()
    check('status transition resets the next activity wait budget', !renewedDone && h.backends.length === 2)
    h.open('slow')
    await renewed
    check('background startup eventually supplies tools without a restart', h.see(a).join() === 'ok,slow' && h.backends.length === 2)
    await h.mounts.dispose()
  }

  // Pending readiness must not monopolize the agent's reconciliation queue.
  {
    const h = harness({ config: { '/A': [srv('healthy'), srv('pending')], '/B': [srv('other')] }, hang: ['pending'], mountWaitMs: 5000 })
    const a = agent('a', '/A')
    const controller = new AbortController()
    const waiting = h.mounts.turn(a, controller.signal)
    await flush()
    controller.abort()
    await waiting
    check('pending reconciliation prerequisite has a healthy binding and unresolved startup', h.see(a).join() === 'healthy' && !h.backends.find(x => x.name === 'pending').connected)
    h.config['/A'] = [srv('healthy', { excludeTools: ['t1'] }), srv('pending'), srv('new')]
    await h.mounts.configChanged('/A')
    await h.mounts.turn(a, AbortSignal.abort())
    await flush()
    check('pending startup does not block filter edits or new server bindings', h.binding(a, 'healthy').exclude.has('t1') && h.see(a).includes('new'))
    a.cwd = '/B'
    await h.mounts.turn(a, AbortSignal.abort())
    await flush()
    check('workspace switch detaches old bindings before pending startup settles', h.see(a).join() === 'other' && h.mounts.liveAgents('/A', 'pending') === 0 && !h.backends.find(x => x.name === 'pending').connected)
    h.open('pending')
    await flush()
    check('late readiness never restores the old workspace tools', h.see(a).join() === 'other')
    await h.mounts.dispose()
  }

  // Idle notifications no longer own backend lifetime.
  {
    const h = harness({ config: { '/A': [srv('s')] }, idleTimeoutMs: 1 })
    const a = agent('a', '/A')
    h.mounts.status(a, 'idle')
    check('status alone starts no server', h.backends.length === 0)
    await h.mounts.turn(a)
    a.status = 'idle'
    h.mounts.status(a, 'idle')
    await new Promise(resolve => setTimeout(resolve, 15))
    check('legacy idle timeout is ignored and tool bindings stay warm', h.live().length === 1 && h.see(a).join() === 's')
    await h.mounts.release(a)
    check('releasing the last idle agent keeps the workspace backend', h.live().length === 1 && h.see(a).length === 0)
    await h.mounts.workspaceRemoved('/A')
    check('workspace removal cleans a backend with no agents', h.live().length === 0)
    await h.mounts.dispose()
  }

  // Config edits affect backends once, while tool filters are cheap per-agent updates.
  {
    const h = harness({ config: { '/A': [srv('keep'), srv('gone'), srv('filtered', { excludeTools: ['t1'] })] } })
    const a = agent('a', '/A'), b = agent('b', '/A')
    await Promise.all([h.mounts.turn(a), h.mounts.turn(b)])
    const old = h.binding(a, 'filtered').backend
    const count = h.backends.length
    check('initial binding receives exclusions and server discovery is reported', h.binding(a, 'filtered').exclude.has('t1') && h.seen.includes('/A#filtered:t1'))
    h.config['/A'] = [srv('keep'), srv('gone'), srv('filtered', { excludeTools: ['t1', 't2'] })]
    await h.mounts.configChanged('/A')
    check('filter config notification does not restart the server or eagerly update bindings', !old.disposed && h.backends.length === count && !h.binding(a, 'filtered').exclude.has('t2'))
    newActivity(h, a)
    check('filter change reports a registration generation change', await h.mounts.turn(a))
    check('filter updates only the current agent binding without restarting', h.binding(a, 'filtered').exclude.has('t2') && !h.binding(b, 'filtered').exclude.has('t2') && h.backends.length === count && h.binding(a, 'filtered').backend === old)
    newActivity(h, b)
    await h.mounts.turn(b)
    check('other agent updates its filter on its next turn', h.binding(b, 'filtered').exclude.has('t2') && h.backends.length === count)
    const updates = h.binding(a, 'filtered').updates
    check('unchanged filter does not change generation', !(await h.mounts.turn(a)) && h.binding(a, 'filtered').updates === updates)
    h.config['/A'] = [srv('keep', { enabled: false }), srv('filtered', { excludeTools: ['t1', 't2'] }), srv('added')]
    await h.mounts.configChanged('/A')
    check('removed and disabled servers stop on all agents immediately', h.backends.filter(x => ['keep', 'gone'].includes(x.name)).every(x => x.disposed) && h.see(a).join() === 'filtered' && h.see(b).join() === 'filtered')
    check('added backend waits until a turn', !h.backends.some(x => x.name === 'added'))
    newActivity(h, a)
    await h.mounts.turn(a)
    check('added backend binds only the agent taking a turn', h.see(a).join() === 'added,filtered' && h.see(b).join() === 'filtered')
    h.config['/A'] = [srv('filtered', { command: 'changed', excludeTools: ['t1', 't2'] }), srv('added')]
    await h.mounts.configChanged('/A')
    newActivity(h, a)
    await h.mounts.turn(a)
    check('transport config change replaces backend once at the next turn', old.disposed && h.binding(a, 'filtered').backend !== old && h.backends.filter(x => x.name === 'filtered').length === 2)
    newActivity(h, b)
    await h.mounts.turn(b)
    check('second agent joins replacement without another restart', h.binding(b, 'filtered').backend === h.binding(a, 'filtered').backend && h.backends.filter(x => x.name === 'filtered').length === 2)
    await h.mounts.workspaceRemoved('/A')
    check('workspace removal clears all bindings and pooled servers', h.live().length === 0 && h.see(a).length === 0 && h.see(b).length === 0)
    await h.mounts.dispose()
  }

  // Replacements share the old transport's shutdown barrier, including scope changes.
  {
    const h = harness({ config: { '/A': [srv('replace')] } })
    const a = agent('a', '/A'), b = agent('b', '/A')
    await Promise.all([h.mounts.turn(a), h.mounts.turn(b)])
    const old = h.binding(a, 'replace').backend
    old.disposeGate = deferred()
    h.config['/A'] = [srv('replace', { command: 'changed' })]
    const changed = h.mounts.configChanged('/A')
    const first = h.mounts.turn(a), second = h.mounts.turn(b)
    await flush()
    check('concurrent replacement waits for one old transport shutdown', h.backends.length === 1 && old.disposeCalls === 1 && !old.disposed)
    old.disposeGate.resolve()
    await Promise.all([changed, first, second])
    check('concurrent replacement starts exactly one successor after shutdown', old.disposed && h.backends.length === 2 && h.binding(a, 'replace').backend === h.binding(b, 'replace').backend)
    h.config['/A'] = [srv('replace', { command: 'changed', scope: 'agent' })]
    await h.mounts.configChanged('/A')
    await Promise.all([h.mounts.turn(a), h.mounts.turn(b)])
    check('workspace-to-agent scope change creates two private successors', h.live().length === 2 && h.binding(a, 'replace').backend !== h.binding(b, 'replace').backend)
    h.config['/A'] = [srv('replace', { command: 'changed' })]
    await h.mounts.configChanged('/A')
    await Promise.all([h.mounts.turn(a), h.mounts.turn(b)])
    check('agent-to-workspace scope change retires private backends and shares again', h.live().length === 1 && h.binding(a, 'replace').backend === h.binding(b, 'replace').backend)
    await h.mounts.dispose()
  }

  // A disposed agent must not cancel shared startup or acquire a late binding.
  {
    const h = harness({ config: { '/A': [srv('pending')] }, hang: ['pending'], mountWaitMs: 5000 })
    const a = agent('a', '/A'), b = agent('b', '/A')
    const controller = new AbortController()
    const turn = h.mounts.turn(a, controller.signal)
    await flush()
    controller.abort()
    await turn
    await a.dispose()
    check('agent release during startup retains shared backend', h.backends.length === 1 && !h.backends[0].disposed && h.mounts.liveAgents('/A', 'pending') === 0)
    const joined = h.mounts.turn(b)
    await flush()
    h.open('pending')
    await joined
    check('late startup binds a later agent, never resurrects disposed agent', h.see(a).length === 0 && h.see(b).join() === 'pending' && h.backends.length === 1)
    await h.mounts.release(b)
    await h.mounts.dispose()
    check('unload cleans shared backend after every agent was released', h.live().length === 0)
    check('turn after unload starts nothing', !(await h.mounts.turn(agent('c', '/A'))) && h.backends.length === 1)
  }
  {
    const h = harness({ config: { '/A': [srv('pending')] }, hang: ['pending'], mountWaitMs: 5000 })
    const a = agent('a', '/A')
    const controller = new AbortController()
    const turn = h.mounts.turn(a, controller.signal)
    await flush()
    controller.abort()
    await turn
    await h.mounts.dispose()
    h.open('pending')
    await flush()
    check('unload during startup prevents late registrations and closes backend', h.backends.length === 1 && h.backends[0].disposed && h.see(a).length === 0)
  }

  // Failed startup has one error per workspace/server, and a later turn retries.
  {
    const h = harness({ config: { '/A': [srv('bad')] }, fail: { bad: 'spawn ENOENT' } })
    const a = agent('a', '/A')
    await h.mounts.turn(a)
    await flush()
    check('startup failure records its cause and leaves no visible tools', h.mounts.lastError('/A', 'bad') === 'spawn ENOENT' && h.see(a).length === 0 && h.mounts.liveAgents('/A', 'bad') === 0)
    check('failed startup backend is disposed', h.backends.length === 1 && h.backends[0].disposed)
    newActivity(h, a)
    await h.mounts.turn(a)
    await flush()
    check('later turn retries failed startup without leaking its predecessor', h.backends.length === 2 && h.backends.every(x => x.disposed))
    h.fail.delete('bad')
    newActivity(h, a)
    check('successful retry reports fresh registrations', await h.mounts.turn(a))
    check('successful retry clears error and mounts usable tools', h.mounts.lastError('/A', 'bad') === undefined && h.see(a).join() === 'bad' && h.backends.length === 3)
    await h.mounts.dispose()
  }
  {
    const h = harness({ config: { '/A': [srv('bad'), srv('worse')] }, fail: { bad: 'boom', worse: 'bang' } })
    const a = agent('a', '/A')
    await h.mounts.turn(a)
    h.config['/A'] = [srv('worse')]
    await h.mounts.configChanged('/A')
    check('removed server clears only its own lastError', h.mounts.lastError('/A', 'bad') === undefined && h.mounts.lastError('/A', 'worse') === 'bang')
    await h.mounts.workspaceRemoved('/A')
    check('removed workspace clears remaining lastErrors', h.mounts.lastError('/A', 'worse') === undefined)
    await h.mounts.dispose()
  }

  // Workspace lookup is retried and bindings move without destroying warm backends.
  {
    const h = harness({ config: { '/A': [srv('s')], '/B': [srv('t')] } })
    const a = agent('a', '/elsewhere')
    check('unmatched workspace has no backend or warning', !(await h.mounts.turn(a)) && h.backends.length === 0 && h.warnings.length === 0)
    h.config['/elsewhere'] = [srv('late')]
    newActivity(h, a)
    await h.mounts.turn(a)
    check('newly available workspace is picked up at the next turn', h.see(a).join() === 'late')
    const late = h.binding(a, 'late').backend
    a.cwd = '/B'
    newActivity(h, a)
    await h.mounts.turn(a)
    check('workspace change removes stale binding but retains old warm backend', h.see(a).join() === 't' && !late.disposed && h.mounts.liveAgents('/elsewhere', 'late') === 0 && h.mounts.agentsIn('/B').includes(a))
    await h.mounts.dispose()
  }
  {
    const h = harness({ config: { '/A': [srv('S'), srv('T')] } })
    const a = agent('a', '/A', 'orchestrator'), b = agent('b', '/A', 'coder')
    await Promise.all([h.mounts.turn(a), h.mounts.turn(b)])
    check('different presets share the same workspace backends and tools', h.see(a).join() === 'S,T' && h.see(b).join() === 'S,T' && h.backends.length === 2)
    await h.mounts.dispose()
  }
  {
    const h = harness({ config: { '/A': [srv('deepwiki'), srv('local')] }, reserved: ['deepwiki'] })
    await h.mounts.turn(agent('a', '/A'))
    check('host candidate filtering keeps profile conflicts out of the pool', h.backends.length === 1 && h.backends[0].name === 'local')
    await h.mounts.dispose()
    const only = harness({ config: { '/A': [srv('deepwiki')] }, reserved: ['deepwiki'] })
    await only.mounts.turn(agent('b', '/A'))
    check('no candidate starts no backend', only.backends.length === 0)
    await only.mounts.dispose()
    const dead = harness({ config: { '/A': [srv('s')] } })
    check('inactive agent never starts a backend', !(await dead.mounts.turn({ ...agent('d', '/A'), inactive: true })) && dead.backends.length === 0)
    await dead.mounts.dispose()
  }
}

// ── 2a. agent workspace resolution ─────────────────────────────────────────
console.log('workspace resolution:')
{
  const { agentWorkspace, collectWorkspaces } = await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/types/discovery.js')).href)
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-mcp-mgr-ws-')))
  const ws = join(tmp, 'ws')
  const other = join(tmp, 'other')
  const link = join(tmp, 'link')
  mkdirSync(ws)
  mkdirSync(other)
  symlinkSync(ws, link, 'junction')
  const previousCwd = process.cwd()
  try {
    const web = { get: name => (name === 'workspaceRegistry' ? { list: () => [{ path: ws }] } : undefined) }
    check('registry: symlinked cwd resolves to the workspace', agentWorkspace(web, link) === ws)
    if (process.platform === 'win32') check('registry: Windows path case resolves to the workspace', agentWorkspace(web, ws.toUpperCase()) === ws)
    check('registry: unmatched or missing cwd resolves to none', agentWorkspace(web, other) === undefined && agentWorkspace(web, undefined) === undefined && agentWorkspace(web, join(tmp, 'nope')) === undefined)
    const headless = { get: () => undefined }
    process.chdir(ws)
    check('AC13 headless: cwd resolving to the host cwd gets its workspace', agentWorkspace(headless, link) === ws && collectWorkspaces(headless).map(w => w.path).join() === ws)
    check('AC13 headless: any other cwd gets none', agentWorkspace(headless, other) === undefined)
    const pending = { get: name => (name === 'loader' ? { entries: () => [{ options: { name: '@deepseek-ai/dsh-workspace' } }] } : undefined) }
    check('AC13 web profile with registry not yet available: no workspace', agentWorkspace(pending, ws) === undefined && collectWorkspaces(pending).length === 0)
    const loaderWith = (entry, logger) => ({ logger, get: name => (name === 'loader' ? { entries: function* () { yield entry } } : undefined) })
    const disabled = loaderWith({ options: { name: '@deepseek-ai/dsh-workspace', disabled: true } })
    const groupOff = loaderWith({ disabled: true, options: { name: 'dsh-workspace' } })
    check('disabled workspace entry (own or group) falls back to headless', agentWorkspace(disabled, link) === ws && agentWorkspace(groupOff, link) === ws && collectWorkspaces(groupOff).map(w => w.path).join() === ws)
    const warned = []
    const failed = loaderWith({ options: { name: '@deepseek-ai/dsh-workspace' }, fiber: { state: 3 } }, { warn: message => warned.push(message) })
    agentWorkspace(failed, link)
    check('failed workspace registry falls back to headless, warned once', agentWorkspace(failed, link) === ws && collectWorkspaces(failed).length === 1 && warned.length === 1, warned.join(' | '))

    // pending registry becomes ready while the agent is running (same activity)
    let registry
    const late = { get: name => (name === 'workspaceRegistry' ? registry : name === 'loader' ? { entries: () => [{ options: { name: 'dsh-workspace' } }] } : undefined) }
    const lateWarnings = []
    let opened = 0
    const lateMounts = new AgentMounts({
      workspaceOf: a => agentWorkspace(late, a.cwd),
      candidates: () => [{ name: 's', enabled: true, excludeTools: [], config: { transport: 'stdio', serverName: 's', command: 'x', args: [], env: {}, cwd: ws, toolCallTimeoutMs: 60000, failOnStartupError: true } }],
      openServer: () => {
        opened += 1
        return {
          ready: Promise.resolve(),
          bind: () => ({ update: () => {}, dispose: async () => {} }),
          dispose: async () => {},
        }
      },
      onAgentDispose: () => () => {},
      isIdle: () => false,
      toolSeen: () => {},
      warn: message => lateWarnings.push(message),
    }, { idleTimeoutMs: 60_000, mountWaitMs: 5_000 })
    const running = { cwd: ws, status: 'running' }
    lateMounts.status(running, 'running')
    const pendingTurn = await lateMounts.turn(running)
    registry = { list: () => [{ path: ws }] }
    const readyTurn = await lateMounts.turn(running)
    check('pending registry: nothing mounted, then mounted at the next step once ready', !pendingTurn && readyTurn && opened === 1 && lateWarnings.length === 0)
    await lateMounts.dispose()
  } finally {
    process.chdir(previousCwd)
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 2b. draft validation ───────────────────────────────────────────────────
console.log('draft validation:')
{
  const { validateDraft } = await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/types/parse.js')).href)
  check('valid stdio draft', validateDraft({ name: 'ok_name-1', transport: 'stdio', command: 'npx' }) === undefined)
  check('valid http draft', validateDraft({ name: 'a', transport: 'streamable-http', url: 'http://x' }) === undefined)
  check('bad name rejected', validateDraft({ name: 'bad.name', transport: 'stdio', command: 'x' }) !== undefined)
  check('missing command rejected', validateDraft({ name: 'a', transport: 'stdio' }) !== undefined)
  check('blank command rejected', validateDraft({ name: 'a', transport: 'stdio', command: '  ' }) !== undefined)
  check('missing url rejected', validateDraft({ name: 'a', transport: 'streamable-http' }) !== undefined)
  check('non-string env rejected', validateDraft({ name: 'a', transport: 'stdio', command: 'x', env: { K: 1 } }) !== undefined)
  check('non-string header rejected', validateDraft({ name: 'a', transport: 'streamable-http', url: 'http://x', headers: { A: 1 } }) !== undefined)
}

// ── 2c. profile tool restrictions ──────────────────────────────────────────
console.log('profile tool restrictions:')
{
  const { ProfileRestrictions, parseProfileTools } = await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/types/restrict.js')).href)
  const parsed = parseProfileTools(JSON.stringify({ excludeTools: { crawl: ['pdf', 'html'], bad: 'x', empty: [] } }))
  check('tools.json parsed; invalid entry reported, empty list dropped', parsed.exclusions.get('crawl')?.join() === 'html,pdf' && !parsed.exclusions.has('empty') && parsed.errors.length === 1)
  check('tools.json invalid JSON reported', parseProfileTools('{').errors.length === 1)
  let exclusions = new Map([['crawl', ['pdf']]])
  const installed = []
  let fail = false
  const warnings = []
  const host = {
    exclusions: () => exclusions,
    globalToolNames: () => ['mcp__crawl__md', 'mcp__crawl__pdf', 'mcp__other__pdf', 'web_fetch'],
    restrict: (agent, deny) => {
      if (fail) throw new Error('unknown global tool')
      const record = { agent, deny: deny.join(), live: true }
      installed.push(record)
      return () => { record.live = false }
    },
    onAgentDispose: (agent, release) => (agent.inactive ? undefined : (agent.dispose = release, () => { agent.unhooked = true })),
    warn: message => warnings.push(message),
  }
  const r = new ProfileRestrictions(host)
  const a = {}
  check('restriction installed with only the excluded server tool', r.apply(a) === true && installed.length === 1 && installed[0].deny === 'mcp__crawl__pdf')
  check('unchanged exclusions: no new restriction', r.apply(a) === false && installed.length === 1)
  exclusions = new Map([['crawl', ['md', 'pdf']]])
  check('changed exclusions: new restriction replaces the old one', r.apply(a) === true && installed.length === 2 && installed[1].deny === 'mcp__crawl__md,mcp__crawl__pdf' && !installed[0].live && installed[1].live)
  exclusions = new Map()
  check('cleared exclusions: restriction lifted', r.apply(a) === true && !installed[1].live)
  check('no exclusions and no state: nothing installed', r.apply({}) === false && installed.length === 2)
  exclusions = new Map([['crawl', ['pdf']]])
  fail = true
  check('refused restriction warns once, keeps going', r.apply(a) === false && r.apply(a) === false && warnings.length === 1)
  fail = false
  check('inactive agent gets no restriction', r.apply({ inactive: true }) === false && installed.length === 2)
  const b = {}
  r.apply(b)
  r.dispose()
  check('dispose lifts every restriction and unhooks', installed.every(record => !record.live) && b.unhooked === true)
  check('after dispose nothing is installed', r.apply({}) === false)
}

// ── 3. profile entry scan ───────────────────────────────────────────────────
console.log('profile scan:')
{
  const { scanProfileEntries, findProfilePatchFile, profileServerNames } = await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/types/profile.js')).href)
  const tmpProfiles = join(root, '.verify-tmp-profiles')
  rmSync(tmpProfiles, { recursive: true, force: true })
  mkdirSync(join(tmpProfiles, 'web'), { recursive: true })
  writeFileSync(join(tmpProfiles, 'web', 'cordis.patch.yml'), '- insert:\n    - id: mcp-deepwiki\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: deepwiki\n        transport: streamable-http\n        url: https://mcp.deepwiki.com/mcp\n    - id: "mcp-quoted"\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: quoted\n        transport: stdio\n', 'utf8')
  const entries = [
    // profile patch entry with a live active fiber
    { id: 'mcp-deepwiki', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'deepwiki', transport: 'streamable-http' } }, fiber: { state: 2, await: async () => undefined } },
    // loader-prefixed entry id must fall back to the raw options.id
    { id: 'root:mcp-quoted', options: { id: 'mcp-quoted', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'quoted', transport: 'stdio' } } },
    // entry with a failed fiber (duplicate serverName at runtime)
    { id: 'mcp-dup', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'dup', transport: 'stdio' } }, fiber: { state: 3, await: async () => { throw new Error('duplicate serverName "dup"') } } },
    // declared but not yet loaded
    { id: 'mcp-idle', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'idle', transport: 'streamable-http' } } },
    // name collision with a workspace server
    { id: 'mcp-clash', options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'unity', transport: 'streamable-http' } } },
    // not an mcp-client entry
    { id: 'mcp-mgr', options: { name: 'dsh-mcp-mgr' } },
    // disabled mcp-client entry
    { id: 'mcp-off', options: { name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { serverName: 'off', transport: 'stdio' } } },
    // bare plugin name spelling
    { id: 'mcp-bare', options: { name: 'dsh-mcp-client', config: { serverName: 'bare', transport: 'stdio' } } },
  ]
  const rows = await scanProfileEntries(entries, new Set(['unity']), tmpProfiles)
  check('profile rows exclude non-mcp entries', rows.every(r => r.source === 'profile'))
  check('active fiber -> active', rows.some(r => r.name === 'deepwiki' && r.status === 'active' && r.sourceFile === join(tmpProfiles, 'web', 'cordis.patch.yml')))
  check('failed fiber -> error with message', rows.some(r => r.name === 'dup' && r.status === 'error' && r.error === 'duplicate serverName "dup"'))
  check('no fiber -> configured', rows.some(r => r.name === 'idle' && r.status === 'configured'))
  check('workspace name collision -> conflict', rows.some(r => r.name === 'unity' && r.status === 'conflict'))
  check('disabled entry -> disabled row with entryId', rows.some(r => r.name === 'off' && r.status === 'disabled' && r.enabled === false && r.entryId === 'mcp-off'))
  check('enabled rows carry enabled flag and loader entryId', rows.find(r => r.name === 'quoted')?.enabled === true && rows.find(r => r.name === 'quoted')?.entryId === 'root:mcp-quoted')
  const offClash = await scanProfileEntries([{ id: 'x', options: { name: 'dsh-mcp-client', disabled: true, config: { serverName: 'unity', transport: 'stdio' } } }], new Set(['unity']), tmpProfiles)
  check('disabled row never flagged conflict', offClash[0]?.status === 'disabled')
  check('bare name spelling included', rows.some(r => r.name === 'bare' && r.transport === 'stdio'))
  check('sorted by name', rows.every((r, i) => i === 0 || rows[i - 1].name <= r.name))
  check('unknown entry has no source file', rows.find(r => r.name === 'idle').sourceFile === undefined)
  check('prefixed id falls back to raw options.id', rows.find(r => r.name === 'quoted')?.sourceFile === join(tmpProfiles, 'web', 'cordis.patch.yml'))
  const reserved = profileServerNames(entries)
  check('AC15 reserved names: live profile servers mapped to entry id', reserved.get('deepwiki') === 'mcp-deepwiki' && !reserved.has('idle') && !reserved.has('dup') && reserved.size === 1)
  const { changeOutcome } = await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/types/profile.js')).href)
  check('changeOutcome applied -> ok', changeOutcome({ application: 'applied' }).ok === true)
  check('changeOutcome unaddressable -> readable error', /cannot be changed/.test(changeOutcome({ application: 'failed', error: { code: 'unaddressable' } }).error))
  check('changeOutcome restart-required -> not ok', /restart/.test(changeOutcome({ application: 'restart-required' }).error))
  check('changeOutcome unknown code keeps diagnostic', changeOutcome({ application: 'failed', error: { code: 'operation-error', diagnostic: 'boom' } }).error === 'operation-error: boom')
  rmSync(tmpProfiles, { recursive: true, force: true })
}

// ── 4. Remote artifact shape ────────────────────────────────────────────────
console.log('remote artifact:')
{
  const contribution = (await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/typert.remote-client.js')).href)).default
  check('package identity', contribution.package === 'dsh-mcp-mgr')
  check('eight methods', contribution.descriptors.length === 8)
  const wsTools = contribution.descriptors.find(d => d.method === 'setServerTools')
  check('setServerTools has three parameters', wsTools?.parameters.map(p => p.wire).join(',') === 'workspace,serverName,excludeTools')
  const profTools = contribution.descriptors.find(d => d.method === 'setProfileServerTools')
  check('setProfileServerTools has two parameters', profTools?.parameters.map(p => p.wire).join(',') === 'serverName,excludeTools')
  const toolSnap = contribution.descriptors.find(d => d.method === 'snapshot').result.create().parse({ servers: [{ key: 'k', source: 'workspace', workspace: '/w', name: 'n', transport: 'stdio', status: 'configured', tools: ['a', 'b'], excludedTools: ['b'] }], watchedWorkspaces: ['/w'] })
  check('snapshot codec keeps tools / excludedTools', toolSnap.servers[0].tools.join() === 'a,b' && toolSnap.servers[0].excludedTools.join() === 'b')
  const profileToggle = contribution.descriptors.find(d => d.method === 'setProfileServerEnabled')
  check('setProfileServerEnabled has two parameters', profileToggle?.parameters.map(p => p.wire).join(',') === 'entryId,enabled')
  const profileSnap = profileToggle && contribution.descriptors.find(d => d.method === 'snapshot').result.create().parse({ servers: [{ key: 'profile#a', source: 'profile', name: 'a', transport: 'stdio', enabled: false, status: 'disabled', entryId: 'a' }], watchedWorkspaces: [] })
  check('snapshot codec keeps profile entryId', profileSnap?.servers[0].entryId === 'a')
  check('removeServer not colliding name', contribution.descriptors.some(d => d.method === 'removeServer') && !contribution.descriptors.some(d => d.method === 'remove'))
  for (const d of contribution.descriptors) {
    check(`strict codec ${d.namespace}/${d.method}`, d.result.mode === 'strict')
  }
  const applyDesc = contribution.descriptors.find(d => d.method === 'apply')
  check('apply has draft parameter', applyDesc.parameters.length === 1 && applyDesc.parameters[0].wire === 'draft')
  check('AC16 no strict-mode / active-workspace Remote methods', !contribution.descriptors.some(d => d.method === 'setStrictMode' || d.method === 'setActiveWorkspace'))
  const toggleDesc = contribution.descriptors.find(d => d.method === 'setServerEnabled')
  check('setServerEnabled has three parameters', toggleDesc.parameters.length === 3 && toggleDesc.parameters.map(p => p.wire).join(',') === 'workspace,serverName,enabled')
  const snapshotSchema = contribution.descriptors.find(d => d.method === 'snapshot').result.create()
  const parsedSnap = snapshotSchema.parse({ servers: [{ key: 'k', source: 'workspace', workspace: '/w', name: 'n', transport: 'stdio', status: 'configured', liveAgents: 2, connectedAgents: 1, lastError: 'spawn ENOENT' }], watchedWorkspaces: ['/w'] })
  check('AC17 snapshot codec keeps liveAgents / connectedAgents / lastError', parsedSnap.servers[0].liveAgents === 2 && parsedSnap.servers[0].connectedAgents === 1 && parsedSnap.servers[0].lastError === 'spawn ENOENT')
  try {
    snapshotSchema.parse({ servers: [{ key: 'k', source: 'workspace', workspace: '/w', name: 'n', transport: 'bogus', status: 'configured' }], watchedWorkspaces: [] })
    check('snapshot codec rejects bad transport', false)
  } catch { check('snapshot codec rejects bad transport', true) }
  try {
    snapshotSchema.parse({ servers: [{ key: 'k', source: 'workspace', workspace: '/w', name: 'n', transport: 'stdio', status: 'connecting' }], watchedWorkspaces: [] })
    check('snapshot codec rejects removed statuses', false)
  } catch { check('snapshot codec rejects removed statuses', true) }
  try {
    snapshotSchema.parse({ servers: [{ key: 'k', source: 'profile', name: 'n', transport: 'streamable-http', status: 'configured', sourceFile: '/x/cordis.patch.yml' }], watchedWorkspaces: [] })
    check('snapshot codec accepts profile row', true)
  } catch { check('snapshot codec accepts profile row', false) }
  const errorSnap = snapshotSchema.parse({ servers: [{ key: '/w#bad', source: 'workspace', workspace: '/w', name: 'bad', status: 'error', error: 'stdio servers require a "command"' }], watchedWorkspaces: ['/w'] })
  check('snapshot codec accepts parse-error row without transport', errorSnap.servers[0].status === 'error' && errorSnap.servers[0].transport === undefined)
  const disabledSnap = snapshotSchema.parse({ servers: [{ key: 'k2', source: 'workspace', workspace: '/w', name: 'n2', enabled: false, transport: 'stdio', status: 'disabled' }], watchedWorkspaces: ['/w'] })
  check('snapshot codec accepts disabled row with enabled flag', disabledSnap.servers[0].enabled === false && disabledSnap.servers[0].status === 'disabled')
  const versionDesc = contribution.descriptors.find(d => d.method === 'versionInfo')
  check('versionInfo has no parameters', versionDesc.parameters.length === 0)
  const versionInfo = versionDesc.result.create().parse({ localVersion: '0.1.4', latestVersion: '0.1.5', updateAvailable: true, updateUrl: 'https://github.com/yangfch3/dsh-mcp-mgr' })
  check('versionInfo codec round-trips', versionInfo.updateAvailable === true && versionInfo.latestVersion === '0.1.5')
}

// ── 3b. strict-mode removal in sources ─────────────────────────────────────
console.log('strict-mode removal:')
{
  const sources = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else sources.push(path)
    }
  }
  walk(join(root, 'packages/dsh-mcp-mgr/src'))
  walk(join(root, 'packages/dsh-mcp-mgr-ui/src'))
  const offenders = sources.filter(path => /strictMode|dsh\.mcpMgr\.strictMode|setActiveWorkspace|activeWorkspace/.test(readFileSync(path, 'utf8')))
  check('AC16 no strict-mode control, Remote method or localStorage key in sources', offenders.length === 0, offenders.join(', '))
  const hostSources = sources.filter(path => path.startsWith(join(root, 'packages/dsh-mcp-mgr/src')))
  const emitters = hostSources.filter(path => /agent-servers|preset|\.(waterfall|emit|parallel|serial|bail)\(/i.test(readFileSync(path, 'utf8')))
  check('AC14 no preset logic and no emitted events in host sources', hostSources.length > 0 && emitters.length === 0, emitters.join(', '))
}

// ── 4. Real registry mount ──────────────────────────────────────────────────
console.log('registry mount:')
{
  const contribution = (await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/typert.remote-client.js')).href)).default
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const dispose = ctx.typert.remotes.register(contribution)
  const snapshot = contribution.descriptors.find(d => d.method === 'snapshot')
  const result = snapshot.result.create().parse({ servers: [], watchedWorkspaces: [] })
  const mounted = () => ctx.typert.remotes.list().filter(d => contribution.descriptors.some(c => c.namespace === d.namespace && c.method === d.method)).length
  check('registered and codec-parseable', mounted() === contribution.descriptors.length && result.watchedWorkspaces.length === 0)
  dispose()
  check('disposer withdraws every descriptor', mounted() === 0)
  await ctx.fiber.dispose()
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
