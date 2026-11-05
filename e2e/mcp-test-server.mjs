/** Small real stdio MCP fixture; records launches and exposes process/workspace identity. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

if (process.env.MCP_PID_DIR) writeFileSync(join(process.env.MCP_PID_DIR, String(process.pid)), '')
const identity = () => ({ pid: process.pid, cwd: process.cwd(), namespace: process.env.MCP_NAMESPACE ?? '' })
const server = new McpServer({ name: 'spike-server', version: '0.0.1' }, {
  instructions: `Workspace namespace: ${process.env.MCP_NAMESPACE ?? ''}`,
})
server.tool('ping', { msg: z.string(), delayMs: z.number().optional(), startedFile: z.string().optional() }, async ({ msg, delayMs, startedFile }) => {
  if (startedFile) writeFileSync(startedFile, String(process.pid))
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
  return { content: [{ type: 'text', text: JSON.stringify({ ...identity(), msg }) }] }
})
server.resource('identity', 'test://identity', {}, async uri => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(identity()) }],
}))
if (process.env.MCP_EXTRA_TOOLS) {
  server.tool('echo', { msg: z.string() }, async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }))
}
if (process.env.MCP_EDGE_TOOLS) {
  let published = false
  server.tool('publish', {}, async () => {
    if (!published) {
      published = true
      server.tool('late', {}, async () => ({ content: [{ type: 'text', text: String(process.pid) }] }))
    }
    return { content: [{ type: 'text', text: 'published' }] }
  })
}
while (process.env.MCP_STARTUP_GATE && !existsSync(process.env.MCP_STARTUP_GATE)) {
  await new Promise(resolve => setTimeout(resolve, 20))
}
await server.connect(new StdioServerTransport())
