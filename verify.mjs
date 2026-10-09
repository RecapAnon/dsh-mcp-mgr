/**
 * dsh-mcp-mgr verification with a fake host:
 *  1. parse mcp.json documents (incl. ${VAR} expansion and rejections)
 *  2. per-agent mounts: lazy mount, wait cap, abort, idle stop, config changes, conflicts, failures; workspace resolution
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
  check('agent mounts fail on startup error', parsed.servers.every(s => s.config.failOnStartupError === true))
  delete process.env.MCP_TEST_TOKEN
}

// ── 2. per-agent mounts (fake host) ─────────────────────────────────────────
console.log('agent mounts:')
{
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const srv = (name, extra = {}) => ({ name, enabled: extra.enabled ?? true, config: { transport: 'stdio', serverName: name, command: extra.command ?? 'x', args: [], env: {}, cwd: '/ws', toolCallTimeoutMs: 60000, failOnStartupError: true } })
  function harness(options = {}) {
    const h = {
      config: options.config ?? {},
      reserved: new Set(options.reserved ?? []),
      hang: new Set(options.hang ?? []),
      gates: new Map(),
      fail: new Map(Object.entries(options.fail ?? {})),
      disposeMs: new Map(Object.entries(options.disposeMs ?? {})),
      started: [],
      disposed: [],
      live: new Set(),
      clashes: 0,
      scopes: 0,
      warnings: [],
      visible: new Map(),
    }
    h.see = agent => [...(h.visible.get(agent) ?? [])].sort()
    h.open = (name) => {
      h.hang.delete(name)
      for (const release of h.gates.get(name) ?? []) release()
      h.gates.delete(name)
    }
    h.host = {
      workspaceOf: agent => (agent.cwd in h.config ? agent.cwd : undefined),
      candidates: ws => (h.config[ws] ?? []).filter(s => s.enabled && !h.reserved.has(s.name)),
      openScope: (agent) => {
        h.scopes += 1
        return {
          mount: (config) => {
            const name = config.serverName
            const id = `${agent.id}:${name}`
            h.started.push(id)
            if (h.live.has(id)) h.clashes += 1
            h.live.add(id)
            let disposed = false
            let release
            const gate = h.hang.has(name)
              ? new Promise((resolve) => { release = resolve; h.gates.set(name, [...(h.gates.get(name) ?? []), resolve]) })
              : sleep(5)
            // Like mcp-client: a failed first connect rejects only with
            // failOnStartupError, after the fiber unloaded (reservation released).
            const ready = gate.then(() => {
              if (disposed) return
              if (h.fail.has(name)) {
                if (!config.failOnStartupError) return
                h.live.delete(id)
                throw new Error(h.fail.get(name))
              }
              if (!h.visible.has(agent)) h.visible.set(agent, new Set())
              h.visible.get(agent).add(name)
            })
            return {
              ready,
              dispose: async () => {
                disposed = true
                release?.()
                await sleep(h.disposeMs.get(name) ?? 0)
                h.visible.get(agent)?.delete(name)
                h.live.delete(id)
                h.disposed.push(id)
              },
            }
          },
          dispose: async () => { h.scopes -= 1 },
        }
      },
      onAgentDispose: (agent, release) => (agent.inactive ? undefined : (agent.dispose = release, () => { agent.unhooked = true })),
      isIdle: agent => agent.status !== 'running',
      warn: message => { h.warnings.push(message) },
    }
    h.mounts = new AgentMounts(h.host, { idleTimeoutMs: options.idleTimeoutMs ?? 60_000, mountWaitMs: options.mountWaitMs ?? 300 })
    return h
  }
  const agent = (id, cwd, preset = 'coder') => ({ id, cwd, preset, status: 'running' })
  const newActivity = (h, a) => { h.mounts.status(a, 'idle'); h.mounts.status(a, 'running') }

  // AC5: per-workspace views; same name mounts in both
  {
    const h = harness({ config: { '/A': [srv('shared'), srv('onlyA')], '/B': [srv('shared', { command: 'y' }), srv('onlyB')] } })
    const a = agent('a', '/A'), b = agent('b', '/B')
    const changedA = await h.mounts.turn(a)
    await h.mounts.turn(b)
    check('AC5 agent A sees only workspace A servers', h.see(a).join() === 'onlyA,shared')
    check('AC5 agent B sees only workspace B servers', h.see(b).join() === 'onlyB,shared')
    check('AC5 same name mounted in both workspaces', h.started.includes('a:shared') && h.started.includes('b:shared'))
    check('AC7 first turn reports a change so assembly re-runs', changedA === true)
    check('AC7 a later turn with nothing new does not re-run', (await h.mounts.turn(a)) === false)
    await h.mounts.dispose()
    check('plugin unload disposes every agent mount', h.see(a).length === 0 && h.see(b).length === 0 && a.unhooked === true && h.scopes === 0)
  }

  // AC6: nothing starts without a turn
  {
    const h = harness({ config: { '/A': [srv('s')] } })
    const a = agent('a', '/A')
    h.mounts.status(a, 'running')
    h.mounts.status(a, 'idle')
    check('AC6 status changes without a turn start nothing', h.started.length === 0 && h.scopes === 0)
  }

  // AC7: a hanging server does not block the turn beyond the cap
  {
    const h = harness({ config: { '/A': [srv('ok'), srv('down')] }, hang: ['down'], mountWaitMs: 150 })
    const a = agent('a', '/A')
    const started = Date.now()
    const changed = await h.mounts.turn(a)
    const elapsed = Date.now() - started
    check('AC7 turn proceeds after the mount wait cap', elapsed >= 140 && elapsed < 1000, `elapsed ${elapsed}`)
    check('AC7 healthy server mounted, hanging one excluded', changed && h.see(a).join() === 'ok')
    const again = Date.now()
    await h.mounts.turn(a)
    check('AC7 a later step of the same activity does not wait again', Date.now() - again < 100)
    await h.mounts.dispose()
  }

  // AC7: a later step waits only for the activity's remaining budget, including a slow stop under the agent lock
  {
    const h = harness({ config: { '/A': [srv('ok')] }, disposeMs: { ok: 400 }, mountWaitMs: 200 })
    const a = agent('a', '/A')
    const t0 = Date.now()
    await h.mounts.turn(a)
    h.config['/A'] = [srv('ok', { command: 'changed' }), srv('slow')]
    h.hang.add('slow')
    await sleep(100)
    const before = Date.now()
    await h.mounts.turn(a)
    const total = Date.now() - t0
    check('AC7 second step stops waiting at the activity deadline', total < 260 && Date.now() - before < 160, `total ${total}`)
    const third = Date.now()
    await h.mounts.turn(a)
    check('AC7 step after the deadline does not wait', Date.now() - third < 30)
    h.open('slow')
    await h.mounts.dispose()
    check('stale mount is disposed before its remount', h.clashes === 0)
  }

  // AC8: abort ends the wait at once; the mount continues in the background
  {
    const h = harness({ config: { '/A': [srv('slow')] }, hang: ['slow'], mountWaitMs: 5000 })
    const a = agent('a', '/A')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    await h.mounts.turn(a, controller.signal)
    const elapsed = Date.now() - started
    check('AC8 abort ends the mount wait at once', elapsed < 300, `elapsed ${elapsed}`)
    const b = agent('b', '/A')
    const pre = Date.now()
    await h.mounts.turn(b, AbortSignal.abort())
    check('AC8 already-aborted turn does not wait', Date.now() - pre < 50)
    h.open('slow')
    await sleep(30)
    check('AC8 mount completes in the background', h.see(a).join() === 'slow' && h.mounts.liveAgents('/A', 'slow') === 2)
    await h.mounts.dispose()
  }

  // AC9: idle stop and remount
  {
    const IDLE = 61
    const h = harness({ config: { '/A': [srv('s1'), srv('s2')] }, idleTimeoutMs: IDLE })
    const a = agent('a', '/A')
    await h.mounts.turn(a)
    const before = h.see(a).join()
    a.status = 'idle'
    h.mounts.status(a, 'idle')
    await sleep(150)
    check('AC9 idle timeout stops the agent mounts', h.see(a).length === 0 && h.mounts.liveAgents('/A', 's1') === 0 && h.scopes === 0)
    a.status = 'running'
    h.mounts.status(a, 'running')
    await h.mounts.turn(a)
    check('AC9 next turn restores identical tools', h.see(a).join() === before)
    const realSetTimeout = globalThis.setTimeout
    let armed = 0
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (ms === IDLE) armed += 1
      return realSetTimeout(fn, ms, ...rest)
    }
    try {
      h.mounts.status(a, 'idle')
      h.mounts.status(a, 'running')
      await sleep(150)
      check('AC9 running clears an armed idle timer', armed === 1 && h.see(a).join() === before)
      h.mounts.status(a, 'idle')
      await sleep(150)
      check('AC9 armed timer firing while the agent runs does not stop', armed === 2 && h.see(a).join() === before)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    await h.mounts.dispose()
  }

  // idle stop in progress when a turn starts
  {
    const h = harness({ config: { '/A': [srv('s')] }, idleTimeoutMs: 30, disposeMs: { s: 100 }, mountWaitMs: 1000 })
    const a = agent('a', '/A')
    await h.mounts.turn(a)
    a.status = 'idle'
    h.mounts.status(a, 'idle')
    await sleep(50)
    a.status = 'running'
    h.mounts.status(a, 'running')
    const changed = await h.mounts.turn(a)
    check('turn during an idle stop waits for it, then remounts', changed && h.see(a).join() === 's' && h.started.filter(s => s === 'a:s').length === 2 && h.clashes === 0)
    await h.mounts.dispose()
  }

  // AC10: subagent mounts its own set and releases it on dispose
  {
    const h = harness({ config: { '/A': [srv('s')] } })
    const main = agent('main', '/A'), sub = agent('sub', '/A')
    await h.mounts.turn(main)
    check('AC10 subagent mounts nothing before its first turn', !h.started.includes('sub:s'))
    await h.mounts.turn(sub)
    check('AC10 subagent mounts its own instance', h.started.includes('sub:s') && h.mounts.liveAgents('/A', 's') === 2)
    await sub.dispose()
    check('AC10 subagent instance disposed with the subagent', h.disposed.includes('sub:s') && h.see(main).join() === 's')
    await h.mounts.dispose()
  }

  // AC11: mcp.json edits
  {
    const h = harness({ config: { '/A': [srv('keep'), srv('gone')] } })
    const a = agent('a', '/A'), b = agent('b', '/A')
    await h.mounts.turn(a)
    await h.mounts.turn(b)
    h.config['/A'] = [srv('keep'), srv('added')]
    await h.mounts.configChanged('/A')
    check('AC11 removed server stops at once on all agents', h.disposed.includes('a:gone') && h.disposed.includes('b:gone'))
    check('AC11 added server not started before the next turn', !h.started.some(s => s.endsWith(':added')))
    newActivity(h, a)
    await h.mounts.turn(a)
    check('AC11 added server appears at the agent\'s next turn', h.see(a).join() === 'added,keep' && !h.started.includes('b:added'))
    h.config['/A'] = [srv('keep', { enabled: false }), srv('added')]
    await h.mounts.configChanged('/A')
    check('AC11 disabled server stops at once', h.disposed.includes('a:keep') && h.disposed.includes('b:keep'))
    h.config['/A'] = [srv('added', { command: 'changed' })]
    newActivity(h, a)
    await h.mounts.turn(a)
    check('changed config remounts at the next turn', h.disposed.includes('a:added') && h.started.filter(s => s === 'a:added').length === 2 && h.clashes === 0)
    await h.mounts.workspaceRemoved('/A')
    check('workspace removal stops every agent', h.see(a).length === 0 && h.see(b).length === 0 && h.scopes === 0)
    await h.mounts.dispose()
  }

  // AC12 / AC13: unmatched cwd mounts nothing; re-checked at the next turn
  {
    const h = harness({ config: { '/A': [srv('s')] } })
    const stray = agent('x', '/elsewhere')
    const changed = await h.mounts.turn(stray)
    check('AC12 unmatched cwd mounts nothing without error', !changed && h.started.length === 0 && h.warnings.length === 0 && h.scopes === 0)
    h.config['/elsewhere'] = [srv('late')]
    newActivity(h, stray)
    await h.mounts.turn(stray)
    check('AC13 workspace that becomes available is picked up at the next turn', h.see(stray).join() === 'late')
    await h.mounts.dispose()
  }

  // AC14: every agent of a workspace gets the same servers regardless of preset
  {
    const h = harness({ config: { '/A': [srv('S'), srv('T')] } })
    const orchestrator = agent('p', '/A', 'orchestrator'), coder = agent('q', '/A', 'coder')
    await h.mounts.turn(orchestrator)
    await h.mounts.turn(coder)
    check('AC14 agents of different presets get identical servers', h.see(orchestrator).join() === 'S,T' && h.see(coder).join() === 'S,T')
    await h.mounts.dispose()
  }

  // AC15: profile-level name conflict
  {
    const h = harness({ config: { '/A': [srv('deepwiki'), srv('local')] }, reserved: ['deepwiki'] })
    const a = agent('a', '/A')
    await h.mounts.turn(a)
    check('AC15 conflicting server never mounted', !h.started.includes('a:deepwiki') && h.see(a).join() === 'local')
    const only = harness({ config: { '/A': [srv('deepwiki')] }, reserved: ['deepwiki'] })
    await only.mounts.turn(agent('b', '/A'))
    check('no scope opened when there are no candidates', only.started.length === 0 && only.scopes === 0)
    await h.mounts.dispose()
  }

  // concurrent assemblies share one in-flight mount
  {
    const h = harness({ config: { '/A': [srv('g')] }, hang: ['g'], mountWaitMs: 2000 })
    const a = agent('a', '/A')
    const first = h.mounts.turn(a)
    const second = h.mounts.turn(a)
    await sleep(20)
    h.open('g')
    const [c1, c2] = await Promise.all([first, second])
    check('concurrent assemblies share one in-flight mount', h.started.length === 1 && c1 && c2 && h.see(a).join() === 'g')
    await h.mounts.dispose()
  }

  // agent dispose / plugin unload during an in-flight mount
  {
    const h = harness({ config: { '/A': [srv('g')] }, hang: ['g'], mountWaitMs: 50 })
    const a = agent('a', '/A')
    await h.mounts.turn(a)
    await a.dispose()
    h.open('g')
    await sleep(20)
    check('agent dispose during an in-flight mount disposes it', h.disposed.includes('a:g') && h.see(a).length === 0 && h.mounts.liveAgents('/A', 'g') === 0 && h.scopes === 0)
    const u = harness({ config: { '/A': [srv('g')] }, hang: ['g'], mountWaitMs: 50 })
    const b = agent('b', '/A')
    await u.mounts.turn(b)
    await u.mounts.dispose()
    u.open('g')
    await sleep(20)
    check('plugin unload during an in-flight mount disposes it', u.disposed.includes('b:g') && u.see(b).length === 0 && u.scopes === 0)
    check('turns after unload mount nothing', (await u.mounts.turn(agent('c', '/A'))) === false && u.started.length === 1)
  }

  // failed startup: recorded, dropped without a registration change, retried at the next turn, warned once
  {
    const h = harness({ config: { '/A': [srv('bad')] }, fail: { bad: 'spawn ENOENT' }, mountWaitMs: 1000 })
    const a = agent('a', '/A')
    const changed = await h.mounts.turn(a)
    check('failed mount records lastError, no change reported', !changed && h.mounts.lastError('/A', 'bad') === 'spawn ENOENT' && h.see(a).length === 0)
    await sleep(20)
    check('failed mount: entry dropped, empty agent scope disposed', h.mounts.liveAgents('/A', 'bad') === 0 && h.scopes === 0 && h.disposed.includes('a:bad'))
    newActivity(h, a)
    const again = await h.mounts.turn(a)
    check('failed mount: remounted at the next turn, still no change', !again && h.started.length === 2 && h.clashes === 0)
    check('failed mount: same error warned once', h.warnings.filter(w => w.includes('spawn ENOENT')).length === 1, h.warnings.join(' | '))
    h.fail.delete('bad')
    newActivity(h, a)
    check('successful remount reports a change', await h.mounts.turn(a))
    check('successful remount clears lastError', h.see(a).join() === 'bad' && h.mounts.lastError('/A', 'bad') === undefined)
    await h.mounts.dispose()
  }

  // stale errors cleared on server or workspace removal
  {
    const h = harness({ config: { '/A': [srv('bad'), srv('worse')] }, fail: { bad: 'boom', worse: 'bang' } })
    const a = agent('a', '/A')
    await h.mounts.turn(a)
    h.config['/A'] = [srv('worse')]
    await h.mounts.configChanged('/A')
    check('removed server drops its lastError', h.mounts.lastError('/A', 'bad') === undefined && h.mounts.lastError('/A', 'worse') === 'bang')
    await h.mounts.workspaceRemoved('/A')
    check('removed workspace drops its lastErrors', h.mounts.lastError('/A', 'worse') === undefined)
    await h.mounts.dispose()
  }

  // inactive agent: nothing mounted
  {
    const h = harness({ config: { '/A': [srv('s')] } })
    const dead = { ...agent('d', '/A'), inactive: true }
    check('inactive agent is never mounted', (await h.mounts.turn(dead)) === false && h.started.length === 0)
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
      candidates: () => [{ name: 's', enabled: true, config: { transport: 'stdio', serverName: 's', command: 'x', args: [], env: {}, cwd: ws, toolCallTimeoutMs: 60000, failOnStartupError: true } }],
      openScope: () => {
        opened += 1
        return { mount: () => ({ ready: Promise.resolve(), dispose: async () => {} }), dispose: async () => {} }
      },
      onAgentDispose: () => () => {},
      isIdle: () => false,
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
  check('disabled entry skipped', !rows.some(r => r.name === 'off'))
  check('bare name spelling included', rows.some(r => r.name === 'bare' && r.transport === 'stdio'))
  check('sorted by name', rows.every((r, i) => i === 0 || rows[i - 1].name <= r.name))
  check('unknown entry has no source file', rows.find(r => r.name === 'idle').sourceFile === undefined)
  check('prefixed id falls back to raw options.id', rows.find(r => r.name === 'quoted')?.sourceFile === join(tmpProfiles, 'web', 'cordis.patch.yml'))
  const reserved = profileServerNames(entries)
  check('AC15 reserved names: live profile servers mapped to entry id', reserved.get('deepwiki') === 'mcp-deepwiki' && !reserved.has('idle') && !reserved.has('dup') && reserved.size === 1)
  rmSync(tmpProfiles, { recursive: true, force: true })
}

// ── 4. Remote artifact shape ────────────────────────────────────────────────
console.log('remote artifact:')
{
  const contribution = (await import(pathToFileURL(join(root, './packages/dsh-mcp-mgr/lib/typert.remote-client.js')).href)).default
  check('package identity', contribution.package === 'dsh-mcp-mgr')
  check('five methods', contribution.descriptors.length === 5)
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
