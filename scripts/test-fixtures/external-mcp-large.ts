import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

// Large tools/list fixture for downstream MCP discovery regression testing.
serveStdio(() => {
  const server = new McpServer({ name: "test-only-large-catalog", version: "1.0.0" })
  for (let i = 0; i < 90; i++) {
    server.registerTool(
      `catalog_tool_${i}`,
      {
        description: `Tool ${i}: ${"A".repeat(19_000)}`,
        inputSchema: z.object({ input: z.string().optional() }),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: "ok" }] })
    )
  }
  return server
})
