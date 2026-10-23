/**
 * stdio launcher for workspace MCP servers.
 *
 * mcp-client negotiates the protocol era by spawning a disposable sibling of
 * the server just to send `server/discover`; a pre-2026 server answers only
 * after its full startup, so every mount paid the startup twice. This shim
 * answers a leading `server/discover` itself (method not found, so the client
 * falls back to the legacy handshake) without starting the server; any other
 * first message starts the real server and pipes stdio through.
 *
 * argv: `<cross-spawn module path> <command> [...args]`
 * @module dsh-mcp-mgr/stdio-shim
 */

import { createRequire } from 'node:module'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

const [spawnModule, command, ...args] = process.argv.slice(2)
let buffered = Buffer.alloc(0)

process.stdin.on('data', onFirstData)
process.stdin.once('end', () => {
  if (buffered.length > 0) start()
})

function onFirstData(chunk: Buffer): void {
  buffered = Buffer.concat([buffered, chunk])
  const newline = buffered.indexOf(10)
  if (newline < 0) return
  process.stdin.off('data', onFirstData)
  const id = discoverId(buffered.subarray(0, newline).toString('utf8'))
  if (id === undefined) {
    start()
    return
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })}\n`)
  buffered = Buffer.alloc(0)
  process.stdin.resume()
}

/** The request id when the line is a `server/discover` request. */
function discoverId(line: string): string | number | undefined {
  try {
    const message = JSON.parse(line) as { method?: unknown; id?: unknown }
    const id = message.id
    return message.method === 'server/discover' && (typeof id === 'string' || typeof id === 'number') ? id : undefined
  } catch {
    return undefined
  }
}

function start(): void {
  process.stdin.pause()
  const spawn = createRequire(import.meta.url)(spawnModule!) as Spawn
  const child = spawn(command!, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  child.on('error', (error) => {
    process.stderr.write(`mcp-mgr stdio shim: cannot start ${command}: ${error.message}\n`)
    process.exitCode = 1
    process.stdin.destroy()
  })
  child.on('close', (code) => {
    process.exitCode = code ?? 1
    process.stdin.destroy()
  })
  child.stdin!.on('error', () => {})
  child.stdin!.write(buffered)
  buffered = Buffer.alloc(0)
  process.stdin.pipe(child.stdin!)
  child.stdout!.pipe(process.stdout)
}
