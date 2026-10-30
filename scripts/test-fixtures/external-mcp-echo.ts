import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

// Disposable test-only MCP fixture; not installed or configured as a user server.
serveStdio(() => {
  const server = new McpServer({ name: "test-only-echo", version: "1.0.0" })
  server.registerTool(
    "echo",
    {
      description: "Echo a supplied string",
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] })
  )
  return server
})
