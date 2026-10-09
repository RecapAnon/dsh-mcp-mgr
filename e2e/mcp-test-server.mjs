/**
 * Minimal stdio MCP server used by the e2e verification. With MCP_PID_DIR set
 * it records its pid there so the test can observe process exit.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

if (process.env.MCP_PID_DIR) writeFileSync(join(process.env.MCP_PID_DIR, String(process.pid)), '')
const server = new McpServer({ name: 'spike-server', version: '0.0.1' })
server.tool(
  'ping',
  { msg: z.string() },
  async ({ msg }) => ({ content: [{ type: 'text', text: `pong:${msg}` }] }),
)
await server.connect(new StdioServerTransport())
