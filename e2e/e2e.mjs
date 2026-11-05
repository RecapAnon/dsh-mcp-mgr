/**
 * End-to-end: McpMgrGateway with the REAL mcp-client, tool registry and
 * scope primitive against real stdio MCP servers. A stub system prompt runs
 * the `system-prompt/assemble` listener chain the way a turn does; fake agents
 * carry a session cwd and an agent-keyed scope. The manager runs as its own
 * plugin so unloading it leaves the root context alive.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const wsE = join(base, 'E')
const outside = join(base, 'outside')
const profileDir = join(base, 'profile')
for (const dir of [pidDir, wsA, wsB, wsC, wsD, wsE, outside, profileDir]) mkdirSync(dir, { recursive: true })
const serverScript = fileURLToPath(new URL('./mcp-test-server.mjs', import.meta.url))
const entry = () => ({ type: 'stdio', command: process.execPath, args: [serverScript], env: { MCP_PID_DIR: pidDir } })
const writeConfig = (ws, names, make = entry) => {
  mkdirSync(join(ws, '.dsh', 'dshmm'), { recursive: true })
  writeFileSync(join(ws, '.dsh', 'dshmm', 'mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(names.map(name => [name, make()])) }, null, 2))
}
writeConfig(wsA, ['spike', 'onlyA'], () => ({ ...entry(), env: { MCP_PID_DIR: pidDir, MCP_NAMESPACE: 'memories-A' } }))
writeConfig(wsB, ['spike'], () => ({ ...entry(), env: { MCP_PID_DIR: pidDir, MCP_NAMESPACE: 'memories-B' } }))
writeConfig(wsC, ['broken'], () => ({ type: 'stdio', command: join(base, 'no-such-executable') }))
writeConfig(wsD, ['multi'], () => ({ ...entry(), env: { MCP_PID_DIR: pidDir, MCP_EXTRA_TOOLS: '1' }, excludeTools: ['echo'] }))
writeConfig(wsE, ['private'], () => ({ ...entry(), scope: 'agent' }))

const alive = () => readdirSync(pidDir).filter((pid) => {
  try { process.kill(Number(pid), 0); return true } catch { return false }
}).length

class StubSystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt'); this.calls = 0; this.sections = new Set() }
  tools() { return () => undefined }
  getSectionOrder() { return 0 }
  section(definition) {
    const entry = { scope: scopeOf(this.ctx), definition }
    return this.ctx.effect(() => {
      this.sections.add(entry)
      return () => this.sections.delete(entry)
    })
  }
  instructions(agent) {
    return [...this.sections].filter(entry => entry.scope === undefined || entry.scope === agent)
      .map(entry => entry.definition.text()).filter(Boolean).join('\n')
  }
  async assemble(context = {}) {
    this.calls += 1
    const tools = this.ctx.get('tools').schemas(context.scope).map(schema => schema.name)
    const assembly = { tools, instructions: this.instructions(context.agent) }
    return this.ctx.waterfall('system-prompt/assemble', assembly, context, async () => assembly)
  }
}

// Implements the inspected register(server, provider) contract, with exact-scope lookup for assertions.
class FakeMcpResources extends Service {
  constructor(ctx) { super(ctx, 'mcpResources'); this.providers = new Map() }
  register(server, provider) {
    const scope = scopeOf(this.ctx)
    return this.ctx.effect(() => {
      let entries = this.providers.get(scope)
      if (!entries) this.providers.set(scope, entries = new Map())
      if (entries.has(server)) throw new Error(`duplicate resource server ${server}`)
      entries.set(server, provider)
      return () => {
        entries.delete(server)
        if (entries.size === 0) this.providers.delete(scope)
      }
    })
  }
  read(agent, server) {
    const provider = this.providers.get(agent)?.get(server)
    if (!provider) throw new Error(`missing resource server ${server}`)
    return provider.request({ method: 'resources/read', uri: 'test://identity' }, {
      agent, signal: new AbortController().signal,
    })
  }
}

class FakeWorkspaceRegistry extends Service {
  constructor(ctx) { super(ctx, 'workspaceRegistry') }
  list() { return [{ path: wsA }, { path: wsB }, { path: wsC }, { path: wsD }, { path: wsE }] }
}

class FakeProfileContext extends Service {
  constructor(ctx) { super(ctx, 'profileContext'); this.name = 'e2e'; this.dir = profileDir }
}

const ctx = new Context()
await ctx.plugin(StubSystemPrompt)
await ctx.plugin(FakeMcpResources)
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
const created = (agent, signal = new AbortController().signal) => ctx.serial('agent/created', { agent, source: 'startup', signal })
let callId = 0
const callPing = (agent, server = 'spike', args = {}, signal = new AbortController().signal) => tools.execute({
  agent, name: `mcp__${server}__ping`, callId: `e2e-${++callId}`, arguments: { msg: 'identity', ...args }, signal,
})
const ping = async (agent, server = 'spike') => {
  const result = await callPing(agent, server)
  if (result.isError) throw new Error(`ping failed: ${JSON.stringify(result)}`)
  return JSON.parse(result.value.content[0].text)
}

try {
  await gateway.rescan()
  const a = makeAgent(wsA)
  const b = makeAgent(wsB)
  check('unannounced agent fixtures start no MCP process', alive() === 0 && view(a).length === 0)
  check('AC17 idle workspace reads configured, not running', row(`${wsA}#spike`)?.status === 'configured' && row(`${wsA}#spike`)?.liveAgents === 0)

  const sub = makeAgent(wsA)
  await Promise.all([created(a), created(sub)])
  check('session-created hook awaits one startup shared by simultaneous agents', alive() === 2 && readdirSync(pidDir).length === 2)
  check('workspace pool never publishes tools or resources globally', tools.schemas().every(schema => !schema.name.startsWith('mcp__')) && !ctx.get('mcpResources').providers.has(undefined))
  const firstA = await turn(a)
  check('AC7 first assembly after creation carries the tools', firstA.join() === 'mcp__onlyA__ping,mcp__spike__ping', firstA.join())
  check('assembly preserves inner and outer listeners once each', lastMarks.join() === 'inner,outer', lastMarks.join())
  const identityA = await ping(a)
  const identitySub = await ping(sub)
  check('main and subagent calls reach the same actual server PID', identityA.pid === identitySub.pid && identityA.cwd === wsA)
  const firstB = await turn(b)
  const identityB = await ping(b)
  check('AC5 workspace B agent sees only B tools', firstB.join() === 'mcp__spike__ping', firstB.join())
  check('same name in another workspace has separate PID, cwd and memory namespace', alive() === 3 && identityA.pid !== identityB.pid && identityB.cwd === wsB && identityA.namespace === 'memories-A' && identityB.namespace === 'memories-B')
  const resources = ctx.get('mcpResources')
  const resourceA = JSON.parse((await resources.read(a, 'spike')).contents[0].text)
  const resourceB = JSON.parse((await resources.read(b, 'spike')).contents[0].text)
  check('resources route through each agent workspace binding', resourceA.pid === identityA.pid && resourceB.pid === identityB.pid)
  check('server instructions are scoped by workspace', systemPrompt.instructions(a).includes('memories-A') && !systemPrompt.instructions(a).includes('memories-B') && systemPrompt.instructions(b).includes('memories-B') && systemPrompt.instructions(undefined) === '')
  const spikeA = row(`${wsA}#spike`)
  check('AC17 row reports subscribing agents / connected agents', spikeA?.liveAgents === 2 && spikeA?.connectedAgents === 2 && spikeA?.lastError === undefined)
  const controller = new AbortController()
  const startedFile = join(base, 'canceled-call-started')
  const canceled = callPing(a, 'spike', { delayMs: 500, startedFile }, controller.signal)
  const survivor = callPing(sub, 'spike', { msg: 'survivor', delayMs: 100 })
  await waitFor(() => existsSync(startedFile), 5_000)
  controller.abort()
  const [canceledResult, survivorResult] = await Promise.all([canceled, survivor])
  check('canceling one caller does not disrupt another on the shared connection', canceledResult.isError && !survivorResult.isError && JSON.parse(survivorResult.value.content[0].text).msg === 'survivor' && (await ping(sub)).pid === identityA.pid)
  await sub.scope.dispose()
  check('disposing one subscriber keeps server and remaining subscriber intact', alive() === 3 && row(`${wsA}#spike`)?.liveAgents === 1 && (await ping(a)).pid === identityA.pid)
  check('disposing subscriber removes resources and instructions', !resources.providers.has(sub) && systemPrompt.instructions(sub) === '')

  const stray = makeAgent(outside)
  check('AC12 unmatched cwd: no workspace tools, no error', (await turn(stray)).length === 0 && alive() === 3)

  const before = view(a).join()
  a.status = 'idle'
  ctx.emit('agent/status', { agent: a, status: 'idle' })
  await new Promise(resolve => setTimeout(resolve, 1_100))
  check('AC9 idle timeout keeps shared servers and bindings warm', alive() === 3 && view(a).join() === before && (await ping(a)).pid === identityA.pid, `alive=${alive()}`)
  a.status = 'running'
  ctx.emit('agent/status', { agent: a, status: 'running' })
  check('AC9 next turn restores identical tools', (await turn(a)).join() === before)

  writeConfig(wsA, ['spike', 'added'], () => ({ ...entry(), env: { MCP_PID_DIR: pidDir, MCP_NAMESPACE: 'memories-A' } }))
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
    const openServer = host.openServer
    let attempts = 0
    host.openServer = (...args) => { attempts += 1; return openServer(...args) }
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
      host.openServer = openServer
    }
  }

  // Workspace exclusions update lightweight bindings, never restart the backend.
  {
    const d = makeAgent(wsD)
    const key = `${wsD}#multi`
    check('excludeTools: excluded workspace tool never registered', (await turn(d)).join() === 'mcp__multi__ping' && view(d).join() === 'mcp__multi__ping')
    check('excludeTools: row lists every tool and the exclusion', row(key)?.tools?.join() === 'echo,ping' && row(key)?.excludedTools?.join() === 'echo', JSON.stringify(row(key)))
    const multiPid = (await ping(d, 'multi')).pid
    const launched = readdirSync(pidDir).length
    const cleared = await gateway.setServerTools(wsD, 'multi', [])
    check('setServerTools: empty list removes the field', cleared.ok && row(key)?.excludedTools === undefined)
    d.status = 'idle'
    ctx.emit('agent/status', { agent: d, status: 'idle' })
    d.status = 'running'
    ctx.emit('agent/status', { agent: d, status: 'running' })
    check('setServerTools: next turn exposes every tool without restarting', (await turn(d)).join() === 'mcp__multi__echo,mcp__multi__ping' && (await ping(d, 'multi')).pid === multiPid && readdirSync(pidDir).length === launched)
    const swapped = await gateway.setServerTools(wsD, 'multi', ['ping'])
    d.status = 'idle'
    ctx.emit('agent/status', { agent: d, status: 'idle' })
    d.status = 'running'
    ctx.emit('agent/status', { agent: d, status: 'running' })
    check('setServerTools: new exclusion applied without a new process', swapped.ok && (await turn(d)).join() === 'mcp__multi__echo' && readdirSync(pidDir).length === launched)
    const bad = await gateway.setServerTools(wsD, 'multi', [''])
    check('setServerTools: rejects empty tool names', bad.ok === false)
    await d.scope.dispose()
  }

  // Stateful servers may explicitly opt out of workspace sharing.
  {
    const one = makeAgent(wsE)
    const two = makeAgent(wsE)
    const baseline = alive()
    await Promise.all([created(one), created(two)])
    const identityOne = await ping(one, 'private')
    const identityTwo = await ping(two, 'private')
    check('scope agent creates independent actual processes', alive() === baseline + 2 && identityOne.pid !== identityTwo.pid)
    await one.scope.dispose()
    await waitFor(() => alive() === baseline + 1, 10_000).catch(() => undefined)
    check('scope agent disposal stops only its own process', alive() === baseline + 1 && (await ping(two, 'private')).pid === identityTwo.pid)
    await two.scope.dispose()
    await waitFor(() => alive() === baseline, 10_000).catch(() => undefined)
    check('scope agent final disposal releases its backend', alive() === baseline)
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

  const warmProcesses = alive()
  const launchesBeforeDisposal = readdirSync(pidDir).length
  await a.scope.dispose()
  await b.scope.dispose()
  await stray.scope.dispose()
  check('last subscriber disposal keeps all workspace backends warm', warmProcesses === 4 && alive() === warmProcesses && row(`${wsB}#spike`)?.liveAgents === 0, `alive=${alive()}`)
  check('last subscriber disposal removes instructions and resource registrations', systemPrompt.instructions(a) === '' && systemPrompt.instructions(b) === '' && !ctx.get('mcpResources').providers.has(a) && !ctx.get('mcpResources').providers.has(b))

  const prof = ctx.plugin({ name: mcpClient.name, inject: mcpClient.inject, apply: mcpClient.apply }, {
    transport: 'stdio', serverName: 'prof', command: process.execPath, args: [serverScript],
    env: { MCP_EXTRA_TOOLS: '1' }, cwd: base, toolCallTimeoutMs: 60000, failOnStartupError: true,
  })
  await prof.await()
  await gateway.setProfileServerTools('prof', ['echo'])
  const c = makeAgent(wsB)
  await turn(c)
  check('later session reuses backend after last subscriber disposal', (await ping(c)).pid === identityB.pid && readdirSync(pidDir).length === launchesBeforeDisposal)
  check('plugin unload: mounted and restricted before unload', alive() === warmProcesses && !tools.schemas(c).some(schema => schema.name === 'mcp__prof__echo'))
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
