/** Real-client regression cases for fan-out failures, notifications, reconnect and pending teardown. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpMgrGateway } from '../packages/dsh-mcp-mgr/lib/types/index.js'
import { waitFor } from './wait-for.mjs'

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-mcp-pool-edges-')))
const pidDir = join(base, 'pids')
const workspace = join(base, 'workspace')
const hanging = join(base, 'hanging')
const gate = join(base, 'start')
const fixture = fileURLToPath(new URL('./mcp-test-server.mjs', import.meta.url))
mkdirSync(pidDir)
for (const [ws, startupGate] of [[workspace, gate], [hanging, join(base, 'never')]]) {
  mkdirSync(join(ws, '.dsh', 'dshmm'), { recursive: true })
  writeFileSync(join(ws, '.dsh', 'dshmm', 'mcp.json'), JSON.stringify({ mcpServers: { edge: {
    type: 'stdio', command: process.execPath, args: [fixture],
    env: { MCP_PID_DIR: pidDir, MCP_EDGE_TOOLS: '1', MCP_STARTUP_GATE: startupGate },
  } } }))
}
const alive = pid => { try { process.kill(Number(pid), 0); return true } catch { return false } }
const livePids = () => readdirSync(pidDir).filter(alive)
class Registry extends Service {
  constructor(ctx) { super(ctx, 'workspaceRegistry') }
  list() { return [{ path: workspace }, { path: hanging }] }
}
class Prompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools() { return () => {} }
  getSectionOrder() { return 0 }
  section() { return () => {} }
}
const ctx = new Context()
await ctx.plugin(Prompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(Registry)
let gateway
const plugin = ctx.plugin({ name: 'pool-edge-manager', inject: ['tools'], apply: inner => {
  gateway = new McpMgrGateway(inner, { enabled: true, rescanIntervalMs: 600000, agentIdleTimeoutMs: 60000, agentMountWaitMs: 5000 })
} })
await plugin.await()
const tools = ctx.get('tools')
const agent = cwd => {
  const result = { status: 'running', session: { header: { cwd } } }
  result.scope = createScope(ctx, result)
  result.ctx = result.scope.ctx
  return result
}
const created = (a, signal = new AbortController().signal) => ctx.serial('agent/created', { agent: a, source: 'startup', signal })
const foreign = async (a, name) => {
  const fiber = a.ctx.plugin({ name: 'agent-local-collision', inject: ['tools'], apply: inner => {
    inner.tools.register({
      name, description: 'Agent-local collision fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] }, execute: async () => null,
    })
  } })
  await fiber.await()
  return async () => { await fiber.dispose(); while (fiber.inertia !== undefined) await fiber.inertia }
}
let sequence = 0
const call = (a, name, args = {}) => tools.execute({ agent: a, name: `mcp__edge__${name}`, callId: `edge-${++sequence}`, arguments: args, signal: new AbortController().signal })
const ping = async a => {
  const result = await call(a, 'ping', { msg: 'edge' })
  assert.equal(result.isError, false, JSON.stringify(result))
  return JSON.parse(result.value.content[0].text).pid
}
const agents = []
try {
  const a = agent(workspace), b = agent(workspace)
  agents.push(a, b)
  const removeCollision = await foreign(a, 'mcp__edge__ping')
  const controller = new AbortController()
  const first = created(a, controller.signal)
  let secondDone = false
  const second = created(b).then(() => { secondDone = true })
  await waitFor(() => livePids().length === 1)
  controller.abort()
  await first
  assert.equal(secondDone, false)
  writeFileSync(gate, '')
  await second
  const firstPid = await ping(b)
  assert.equal(livePids().length, 1)
  assert.equal(gateway.mounts.lastError(workspace, 'edge'), undefined)
  await removeCollision()
  assert.equal(await gateway.mounts.turn(a), true)
  assert.equal(await ping(a), firstPid)
  console.log('  ok: one subscriber collision cannot fail shared startup; next turn repairs its binding')

  const removeLateCollision = await foreign(b, 'mcp__edge__late')
  assert.equal((await call(a, 'publish')).isError, false)
  await waitFor(() => tools.get('mcp__edge__late', a) !== undefined)
  assert.equal((await call(a, 'late')).isError, false)
  assert.equal(await ping(a), firstPid)
  assert.equal(await ping(b), firstPid)
  await removeLateCollision()
  await gateway.mounts.turn(b)
  assert.equal((await call(b, 'late')).isError, false)
  assert.equal(livePids().length, 1)
  console.log('  ok: dynamic tool notification fans out despite one agent collision, without restarting')

  const oldDefinition = tools.get('mcp__edge__ping', a)
  process.kill(firstPid)
  await waitFor(() => tools.get('mcp__edge__ping', a) !== oldDefinition, 15000)
  const nextPid = await ping(a)
  assert.notEqual(nextPid, firstPid)
  assert.equal(await ping(b), nextPid)
  assert.equal(tools.get('mcp__edge__late', a), undefined)
  assert.equal(tools.get('mcp__edge__late', b), undefined)
  assert.equal(readdirSync(pidDir).length, 2)
  console.log('  ok: one reconnect replaces the shared process and refreshes tools for all subscribers')

  const startedFile = join(base, 'disposing-caller-started')
  const inFlight = call(a, 'ping', { msg: 'disposing', delayMs: 200, startedFile })
  await waitFor(() => existsSync(startedFile))
  await a.scope.dispose()
  assert.equal((await inFlight).isError, false)
  assert.equal(await ping(b), nextPid)
  console.log('  ok: disposing an in-flight caller does not close the shared connection')

  const c = agent(hanging)
  agents.push(c)
  const stopWaiting = new AbortController()
  const pending = created(c, stopWaiting.signal)
  await waitFor(() => livePids().length === 2)
  stopWaiting.abort()
  await pending
  await c.scope.dispose()
  assert.equal(livePids().length, 2)
  const start = Date.now()
  await plugin.dispose()
  while (plugin.inertia !== undefined) await plugin.inertia
  assert.ok(Date.now() - start < 10000, 'pending startup shutdown should not wait for the protocol handshake timeout')
  await waitFor(() => livePids().length === 0, 10000)
  assert.equal(tools.schemas(a).length, 0)
  assert.equal(tools.schemas(b).length, 0)
  console.log('  ok: real pending handshake survives last subscriber release and stops on manager unload')
} finally {
  await plugin.dispose()
  while (plugin.inertia !== undefined) await plugin.inertia
  for (const a of agents) await a.scope.dispose()
  await ctx.fiber.dispose()
  rmSync(base, { recursive: true, force: true })
}
console.log('POOL EDGES PASS')
