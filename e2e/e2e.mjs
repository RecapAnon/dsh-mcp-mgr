/**
 * End-to-end: McpMgrGateway with the REAL mcp-client, tool registry and
 * scope primitive against real stdio MCP servers. A stub system prompt runs
 * the `system-prompt/assemble` listener chain the way a turn does; fake agents
 * carry a session cwd and an agent-keyed scope. The manager runs as its own
 * plugin so unloading it leaves the root context alive.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { McpMgrGateway } from '../packages/dsh-mcp-mgr/lib/types/index.js'
import { waitFor } from './wait-for.mjs'

let failures = 0
function check(label, condition, detail = '') {
  console.log(condition ? `  ok: ${label}` : `  FAIL: ${label} ${detail}`)
  if (!condition) failures += 1
}

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-mcp-mgr-e2e-')))
const pidDir = join(base, 'pids')
const wsA = join(base, 'A')
const wsB = join(base, 'B')
const wsC = join(base, 'C')
const wsD = join(base, 'D')
const outside = join(base, 'outside')
const profileDir = join(base, 'profile')
for (const dir of [pidDir, wsA, wsB, wsC, wsD, outside, profileDir]) mkdirSync(dir, { recursive: true })
const serverScript = fileURLToPath(new URL('./mcp-test-server.mjs', import.meta.url))
const entry = () => ({ type: 'stdio', command: process.execPath, args: [serverScript], env: { MCP_PID_DIR: pidDir } })
const writeConfig = (ws, names, make = entry) => {
  mkdirSync(join(ws, '.dsh', 'dshmm'), { recursive: true })
  writeFileSync(join(ws, '.dsh', 'dshmm', 'mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(names.map(name => [name, make()])) }, null, 2))
}
writeConfig(wsA, ['spike', 'onlyA'])
writeConfig(wsB, ['spike'])
writeConfig(wsC, ['broken'], () => ({ type: 'stdio', command: join(base, 'no-such-executable') }))
writeConfig(wsD, ['multi'], () => ({ ...entry(), env: { MCP_PID_DIR: pidDir, MCP_EXTRA_TOOLS: '1' }, excludeTools: ['echo'] }))

const alive = () => readdirSync(pidDir).filter((pid) => {
  try { process.kill(Number(pid), 0); return true } catch { return false }
}).length

class StubSystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt'); this.calls = 0 }
  tools() { return () => undefined }
  async assemble(context = {}) {
    this.calls += 1
    const tools = this.ctx.get('tools').schemas(context.scope).map(schema => schema.name)
    const assembly = { tools }
    return this.ctx.waterfall('system-prompt/assemble', assembly, context, async () => assembly)
  }
}

class FakeWorkspaceRegistry extends Service {
  constructor(ctx) { super(ctx, 'workspaceRegistry') }
  list() { return [{ path: wsA }, { path: wsB }, { path: wsC }, { path: wsD }] }
}

class FakeProfileContext extends Service {
  constructor(ctx) { super(ctx, 'profileContext'); this.name = 'e2e'; this.dir = profileDir }
}

const ctx = new Context()
await ctx.plugin(StubSystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(FakeWorkspaceRegistry)
await ctx.plugin(FakeProfileContext)
let gateway
const plugin = ctx.plugin({
  name: 'mcp-mgr',
  inject: ['tools'],
  apply: (pluginCtx) => {
    gateway = new McpMgrGateway(pluginCtx, { enabled: true, rescanIntervalMs: 600_000, agentIdleTimeoutMs: 1_000, agentMountWaitMs: 20_000 })
  },
})
await plugin.await()
const mark = label => async (_assembly, _context, next) => {
  const result = await next()
  return { ...result, marks: [...(result.marks ?? []), label] }
}
ctx.on('system-prompt/assemble', mark('outer'), { prepend: true })
ctx.on('system-prompt/assemble', mark('inner'))
let lastMarks = []
const systemPrompt = ctx.get('systemPrompt')
const tools = ctx.get('tools')

function makeAgent(cwd) {
  const agent = { status: 'running', session: { header: { cwd } } }
  agent.scope = createScope(ctx, agent)
  agent.ctx = agent.scope.ctx
  return agent
}
const turn = async (agent) => {
  const result = await systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal })
  lastMarks = result.marks ?? []
  return result.tools.filter(name => name.startsWith('mcp__')).sort()
}
const view = agent => tools.schemas(agent).map(schema => schema.name).filter(name => name.startsWith('mcp__')).sort()
const row = key => gateway.snapshot().servers.find(server => server.key === key)

try {
  await gateway.rescan()
  const a = makeAgent(wsA)
  const b = makeAgent(wsB)
  check('AC6 open agents without a turn start no MCP process', alive() === 0 && view(a).length === 0)
  check('AC17 idle workspace reads configured, not running', row(`${wsA}#spike`)?.status === 'configured' && row(`${wsA}#spike`)?.liveAgents === 0)

  const firstA = await turn(a)
  check('AC7 first assembly of the first turn carries the tools', firstA.join() === 'mcp__onlyA__ping,mcp__spike__ping', firstA.join())
  check('re-assembly applies inner and outer listeners once each', lastMarks.join() === 'inner,outer', lastMarks.join())
  check('stdio server started once per mount (no era-probe sibling)', readdirSync(pidDir).length === 2, `spawned=${readdirSync(pidDir).length}`)
  const firstB = await turn(b)
  check('AC5 workspace B agent sees only B tools', firstB.join() === 'mcp__spike__ping', firstB.join())
  check('AC5 same server name runs for both workspaces', alive() === 3, `alive=${alive()}`)
  const spikeA = row(`${wsA}#spike`)
  check('AC17 row reports liveAgents / connectedAgents', spikeA?.liveAgents === 1 && spikeA?.connectedAgents === 1 && spikeA?.lastError === undefined)

  const sub = makeAgent(wsA)
  check('AC10 subagent starts nothing before its first turn', alive() === 3)
  await turn(sub)
  check('AC10 subagent mounts its own servers', alive() === 5 && row(`${wsA}#spike`)?.liveAgents === 2)
  await sub.scope.dispose()
  await waitFor(() => alive() === 3, 10_000).catch(() => undefined)
  check('AC10 subagent processes exit when it is disposed', alive() === 3 && row(`${wsA}#spike`)?.liveAgents === 1, `alive=${alive()}`)

  const stray = makeAgent(outside)
  check('AC12 unmatched cwd: no workspace tools, no error', (await turn(stray)).length === 0 && alive() === 3)

  const before = view(a).join()
  a.status = 'idle'
  ctx.emit('agent/status', { agent: a, status: 'idle' })
  await waitFor(() => alive() === 1, 10_000).catch(() => undefined)
  check('AC9 idle timeout stops the agent processes', alive() === 1 && view(a).length === 0, `alive=${alive()}`)
  a.status = 'running'
  ctx.emit('agent/status', { agent: a, status: 'running' })
  check('AC9 next turn restores identical tools', (await turn(a)).join() === before)

  writeConfig(wsA, ['spike', 'added'])
  await gateway.rescan()
  await waitFor(() => alive() === 2, 10_000).catch(() => undefined)
  check('AC11 removed server stops at once', alive() === 2 && !view(a).includes('mcp__onlyA__ping'), `alive=${alive()}`)
  check('AC11 added server not started before the next turn', !view(a).includes('mcp__added__ping'))
  check('AC11 added server appears at the next turn', (await turn(a)).join() === 'mcp__added__ping,mcp__spike__ping')

  // registrations changed but the turn aborted meanwhile: no re-assembly, the chain continues
  {
    const d = makeAgent(wsB)
    const controller = new AbortController()
    const mounts = gateway.mounts
    const realTurn = mounts.turn
    let sawChanged
    mounts.turn = async function (...args) {
      sawChanged = await realTurn.apply(this, args)
      controller.abort()
      return sawChanged
    }
    const calls = systemPrompt.calls
    let result
    try {
      result = await systemPrompt.assemble({ agent: d, scope: d, signal: controller.signal })
    } finally {
      mounts.turn = realTurn
    }
    check('changed && aborted: no re-assembly, next() still runs', sawChanged === true && systemPrompt.calls === calls + 1 && (result.marks ?? []).join() === 'inner,outer')
    check('changed && aborted: stale assembly kept, tools registered for the next step', result.tools.every(name => !name.startsWith('mcp__')) && view(d).join() === 'mcp__spike__ping')
    await d.scope.dispose()
  }

  // failed startup (non-existent executable): recorded, no re-assembly, retried at the next turn
  {
    const host = gateway.mounts.host
    const openScope = host.openScope
    let attempts = 0
    host.openScope = (agent) => {
      const scope = openScope(agent)
      return { ...scope, mount: (config) => { attempts += 1; return scope.mount(config) } }
    }
    try {
      const broken = makeAgent(wsC)
      const key = `${wsC}#broken`
      const calls = systemPrompt.calls
      const first = await turn(broken)
      const failed = row(key)
      check('failed startup: lastError set, no tools, connectedAgents 0', first.length === 0 && typeof failed?.lastError === 'string' && failed.connectedAgents === 0, JSON.stringify(failed))
      check('failed startup: no re-assembly', systemPrompt.calls === calls + 1 && attempts === 1)
      await waitFor(() => row(key)?.liveAgents === 0, 10_000).catch(() => undefined)
      check('failed startup: mount dropped', row(key)?.liveAgents === 0)
      broken.status = 'idle'
      ctx.emit('agent/status', { agent: broken, status: 'idle' })
      broken.status = 'running'
      ctx.emit('agent/status', { agent: broken, status: 'running' })
      await turn(broken)
      check('failed startup: remount attempted at the next turn', attempts === 2 && systemPrompt.calls === calls + 2 && typeof row(key)?.lastError === 'string')
      await broken.scope.dispose()
    } finally {
      host.openScope = openScope
    }
  }

  // workspace excludeTools: filtered at registration, change remounts at the next turn
  {
    const d = makeAgent(wsD)
    const key = `${wsD}#multi`
    check('excludeTools: excluded workspace tool never registered', (await turn(d)).join() === 'mcp__multi__ping' && view(d).join() === 'mcp__multi__ping')
    check('excludeTools: row lists every tool and the exclusion', row(key)?.tools?.join() === 'echo,ping' && row(key)?.excludedTools?.join() === 'echo', JSON.stringify(row(key)))
    const cleared = await gateway.setServerTools(wsD, 'multi', [])
    check('setServerTools: empty list removes the field', cleared.ok && row(key)?.excludedTools === undefined)
    d.status = 'idle'
    ctx.emit('agent/status', { agent: d, status: 'idle' })
    d.status = 'running'
    ctx.emit('agent/status', { agent: d, status: 'running' })
    check('setServerTools: next turn remounts with every tool', (await turn(d)).join() === 'mcp__multi__echo,mcp__multi__ping')
    const swapped = await gateway.setServerTools(wsD, 'multi', ['ping'])
    d.status = 'idle'
    ctx.emit('agent/status', { agent: d, status: 'idle' })
    d.status = 'running'
    ctx.emit('agent/status', { agent: d, status: 'running' })
    check('setServerTools: new exclusion applied at the next turn', swapped.ok && (await turn(d)).join() === 'mcp__multi__echo')
    const bad = await gateway.setServerTools(wsD, 'multi', [''])
    check('setServerTools: rejects empty tool names', bad.ok === false)
    await d.scope.dispose()
  }

  // profile tools.json: global tools hidden per agent through tools.restrict
  {
    const prof = ctx.plugin({ name: mcpClient.name, inject: mcpClient.inject, apply: mcpClient.apply }, {
      transport: 'stdio', serverName: 'prof', command: process.execPath, args: [serverScript],
      env: { MCP_PID_DIR: pidDir, MCP_EXTRA_TOOLS: '1' }, cwd: base, toolCallTimeoutMs: 60000, failOnStartupError: true,
    })
    await prof.await()
    const p = makeAgent(outside)
    check('profile tools: all global tools visible before any exclusion', (await turn(p)).join() === 'mcp__prof__echo,mcp__prof__ping')
    const saved = await gateway.setProfileServerTools('prof', ['echo'])
    const stored = JSON.parse(readFileSync(join(profileDir, 'dshmm', 'tools.json'), 'utf8'))
    check('setProfileServerTools: written to <profileDir>/dshmm/tools.json', saved.ok && stored.excludeTools.prof.join() === 'echo', JSON.stringify(stored))
    check('profile tools: excluded tool hidden from the same turn assembly', (await turn(p)).join() === 'mcp__prof__ping' && view(p).join() === 'mcp__prof__ping')
    check('profile tools: global view keeps the tool', tools.schemas().some(schema => schema.name === 'mcp__prof__echo'))
    const other = makeAgent(wsB)
    check('profile tools: every agent gets the restriction', (await turn(other)).join() === 'mcp__prof__ping,mcp__spike__ping')
    await gateway.setProfileServerTools('prof', [])
    check('profile tools: clearing the list restores the tool at the next turn', (await turn(p)).join() === 'mcp__prof__echo,mcp__prof__ping')
    check('setProfileServerTools: empty list removes the server key', JSON.stringify(JSON.parse(readFileSync(join(profileDir, 'dshmm', 'tools.json'), 'utf8'))) === '{}')
    writeFileSync(join(profileDir, 'dshmm', 'tools.json'), JSON.stringify({ excludeTools: { prof: ['ping'] } }))
    await gateway.rescan()
    check('profile tools: hand edit picked up by the rescan', (await turn(p)).join() === 'mcp__prof__echo')
    await gateway.setProfileServerTools('prof', [])
    await turn(p)
    await other.scope.dispose()
    await p.scope.dispose()
    await prof.dispose()
  }

  {
    const profileEntry = { id: 'root:crawl', options: { id: 'crawl', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'crawl', transport: 'stdio' } } }
    const calls = []
    class FakeLoader extends Service {
      constructor(c) { super(c, 'loader') }
      entries() { return [profileEntry, { id: 'other', options: { name: 'dsh-other' } }] }
    }
    class FakePluginManager extends Service {
      constructor(c) { super(c, 'pluginManager') }
      async setPluginEnabled(id, enabled) {
        calls.push([id, enabled])
        profileEntry.options = { ...profileEntry.options, disabled: !enabled }
        return { changed: true, application: 'applied', stage: 'enable', target: id, enabled }
      }
    }
    const profileRow = () => gateway.snapshot().servers.find(r => r.key === 'profile#crawl')
    await ctx.plugin(FakeLoader)
    const unmanaged = await gateway.setProfileServerEnabled('root:crawl', false)
    check('profile toggle without plugin manager: refused', unmanaged.ok === false && /plugin manager is unavailable/.test(unmanaged.error))
    await ctx.plugin(FakePluginManager)
    const off = await gateway.setProfileServerEnabled('root:crawl', false)
    check('profile disable: plugin manager called with the loader entry id', off.ok && calls.at(-1)?.join() === 'root:crawl,false')
    check('profile disable: row shows disabled after the rescan', profileRow()?.status === 'disabled' && profileRow()?.enabled === false)
    const on = await gateway.setProfileServerEnabled('root:crawl', true)
    check('profile enable: row back to configured', on.ok && profileRow()?.status === 'configured' && profileRow()?.enabled === true)
    const foreign = await gateway.setProfileServerEnabled('other', false)
    check('profile toggle refuses non mcp-client entries', foreign.ok === false && calls.length === 2)
  }

  await a.scope.dispose()
  await b.scope.dispose()
  await stray.scope.dispose()
  await waitFor(() => alive() === 0, 10_000).catch(() => undefined)
  check('agent disposal stops every remaining process', alive() === 0, `alive=${alive()}`)

  const prof = ctx.plugin({ name: mcpClient.name, inject: mcpClient.inject, apply: mcpClient.apply }, {
    transport: 'stdio', serverName: 'prof', command: process.execPath, args: [serverScript],
    env: { MCP_EXTRA_TOOLS: '1' }, cwd: base, toolCallTimeoutMs: 60000, failOnStartupError: true,
  })
  await prof.await()
  await gateway.setProfileServerTools('prof', ['echo'])
  const c = makeAgent(wsB)
  await turn(c)
  check('plugin unload: mounted and restricted before unload', alive() === 1 && !tools.schemas(c).some(schema => schema.name === 'mcp__prof__echo'))
  await plugin.dispose()
  check('plugin unload lifts profile tool restrictions', tools.schemas(c).some(schema => schema.name === 'mcp__prof__echo'))
  await prof.dispose()
  await waitFor(() => alive() === 0, 10_000).catch(() => undefined)
  check('plugin unload (plugin scope only) stops agent processes', alive() === 0, `alive=${alive()}`)
  check('plugin unload leaves agents and root services intact', view(c).length === 0 && ctx.get('tools') !== undefined)
  const after = await systemPrompt.assemble({ agent: c, scope: c, signal: new AbortController().signal })
  check('turns after plugin unload mount nothing', after.tools.every(name => !name.startsWith('mcp__')) && alive() === 0)
} finally {
  await ctx.fiber.dispose()
  rmSync(base, { recursive: true, force: true })
}

console.log(failures === 0 ? 'E2E PASS' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
