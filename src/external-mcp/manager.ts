import process from "node:process"
import type { Transport } from "@modelcontextprotocol/client"
import {
  type CallToolResult,
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { ExternalMcpRegistry, type ExternalServerDefinition, serverDefinition } from "./registry.js"
import { fitExternalMcpResult } from "./result-images.js"

type Connection = { client: Client; tools?: Tool[]; definition: ExternalServerDefinition }
type Status = {
  id: string
  name: string
  transport: string
  enabled: boolean
  state: "disconnected" | "connected" | "error"
  toolCount: number
  error?: string
  allowedTools: string[]
}

export class ExternalMcpManager {
  readonly registry: ExternalMcpRegistry
  private connections = new Map<string, Connection>()
  private pending = new Map<string, Promise<Connection>>()
  private errors = new Map<string, string>()
  private closed = false

  constructor(stateDir: string) {
    this.registry = new ExternalMcpRegistry(stateDir)
  }

  async start(): Promise<void> {
    const { servers } = await this.registry.read()
    await Promise.allSettled(
      servers.filter((server) => server.enabled).map((server) => this.connect(server.id))
    )
  }

  async list(): Promise<Status[]> {
    const registry = await this.registry.read()
    return registry.servers.map((server) => {
      const connection = this.connections.get(server.id)
      let state: Status["state"] = "disconnected"
      if (connection) state = "connected"
      else if (this.errors.has(server.id)) state = "error"
      return {
        id: server.id,
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        state,
        toolCount: connection?.tools?.length ?? 0,
        ...(this.errors.has(server.id) ? { error: this.errors.get(server.id) } : {}),
        allowedTools: server.allowedTools,
      }
    })
  }

  async discover(
    id: string,
    query?: string,
    refresh = false
  ): Promise<Array<{ name: string; description?: string; allowed: boolean }>> {
    if (refresh) {
      const connection = await this.getConnection(id)
      connection.tools = undefined
    }
    const { tools, definition } = await this.discoverTools(id)
    const needle = query?.toLowerCase()
    return tools
      .filter(
        (tool) => !needle || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(needle)
      )
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description.slice(0, 350) } : {}),
        allowed: definition.allowedTools.includes(tool.name),
      }))
  }

  async inspect(id: string, toolName: string): Promise<Tool & { allowed: boolean }> {
    const { tools, definition } = await this.discoverTools(id)
    const tool = tools.find((entry) => entry.name === toolName)
    if (!tool) throw new Error(`Unknown tool ${toolName} on server ${id}`)
    return { ...tool, allowed: definition.allowedTools.includes(toolName) }
  }

  async call(
    id: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000
  ): Promise<CallToolResult> {
    const { connection, tools, definition } = await this.discoverTools(id)
    if (!definition.allowedTools.includes(toolName))
      throw new Error(
        `Tool ${toolName} on ${id} is not approved. Enable it in the local dashboard first.`
      )
    if (!tools.some((tool) => tool.name === toolName))
      throw new Error(`Unknown tool ${toolName} on server ${id}`)
    const result = await connection.client.callTool(
      { name: toolName, arguments: args },
      { signal, timeout: timeoutMs }
    )
    // Preserve native MCP image blocks but fit large previews into the existing
    // response budget. Never relax the cap for arbitrary text or structured data.
    return fitExternalMcpResult(result)
  }

  async connect(id: string): Promise<void> {
    await this.getConnection(id)
  }
  async disconnect(id: string): Promise<void> {
    this.errors.delete(id)
    const pending = this.pending.get(id)
    if (pending) await pending.catch(() => undefined)
    const connection = this.connections.get(id)
    this.connections.delete(id)
    if (connection) await connection.client.close()
  }

  async save(value: unknown): Promise<void> {
    const definition = serverDefinition.parse(value)
    await this.registry.save(definition)
    await this.disconnect(definition.id)
  }
  async remove(id: string): Promise<void> {
    await this.disconnect(id)
    await this.registry.remove(id)
  }
  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.pending.values()]
    await Promise.allSettled(pending)
    await Promise.allSettled([...this.connections.values()].map(({ client }) => client.close()))
    this.connections.clear()
  }

  private async discoverTools(
    id: string
  ): Promise<{ connection: Connection; tools: Tool[]; definition: ExternalServerDefinition }> {
    const connection = await this.getConnection(id)
    if (!connection.tools) {
      const response = await connection.client.listTools(undefined, {
        cacheMode: "refresh",
        timeout: 10_000,
      })
      connection.tools = response.tools
    }
    return { connection, definition: connection.definition, tools: connection.tools }
  }

  private async getConnection(id: string): Promise<Connection> {
    if (this.closed) throw new Error("External MCP manager is shutting down")
    const existing = this.connections.get(id)
    if (existing) return existing
    const waiting = this.pending.get(id)
    if (waiting) return waiting
    const task = this.openConnection(id)
    this.pending.set(id, task)
    try {
      return await task
    } finally {
      this.pending.delete(id)
    }
  }

  private async openConnection(id: string): Promise<Connection> {
    const registry = await this.registry.read()
    const definition = registry.servers.find((server) => server.id === id)
    if (!definition) throw new Error(`Unknown external MCP server: ${id}`)
    if (!definition.enabled) throw new Error(`External MCP server ${id} is disabled`)
    let transport: Transport
    if (definition.transport === "stdio") {
      const env = { ...getDefaultEnvironment() }
      for (const [target, source] of Object.entries(definition.env)) {
        const value = process.env[source]
        if (value === undefined) throw new Error(`Missing environment variable ${source} for ${id}`)
        env[target] = value
      }
      transport = new StdioClientTransport({
        command: definition.command,
        args: definition.args,
        cwd: definition.cwd,
        env,
        stderr: "ignore",
        // Large legitimate MCP servers can return multi-megabyte tools/list
        // responses (REA 6.8.0 advertises 229 tools, approximately 3.5 MB).
        // Keep an explicit bound without truncating discovery messages.
        maxBufferSize: 8 * 1_024 * 1_024,
      })
    } else {
      const headers: Record<string, string> = {}
      if (definition.bearerTokenEnv) {
        const value = process.env[definition.bearerTokenEnv]
        if (!value) throw new Error(`Missing credential environment variable for ${id}`)
        headers.Authorization = `Bearer ${value}`
      }
      const url = new URL(definition.url)
      const options = { requestInit: { headers, redirect: "error" as const } }
      transport =
        definition.transport === "sse"
          ? new SSEClientTransport(url, options)
          : new StreamableHTTPClientTransport(url, options)
    }
    const client = new Client(
      { name: "shellby-external-mcp", version: "1.0.0" },
      { capabilities: {} }
    )
    try {
      await client.connect(transport, { signal: AbortSignal.timeout(10_000) })
      const connection: Connection = { client, definition }
      client.setNotificationHandler("notifications/tools/list_changed", () => {
        connection.tools = undefined
      })
      client.onclose = () => {
        if (this.connections.get(id) === connection) this.connections.delete(id)
      }
      this.connections.set(id, connection)
      this.errors.delete(id)
      return connection
    } catch (error) {
      await client.close().catch(() => undefined)
      const message = error instanceof Error ? error.message : "Connection failed"
      this.errors.set(id, message.slice(0, 250))
      throw new Error(`Failed to connect to external MCP ${id}: ${message}`, { cause: error })
    }
  }
}
