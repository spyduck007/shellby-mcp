import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"
import test from "node:test"
import { createAgentObserver } from "../src/agent/observer.js"
import { ExternalMcpManager } from "../src/external-mcp/manager.js"
import { serverDefinition } from "../src/external-mcp/registry.js"
import { tempDir } from "./helpers/temp.js"
import { connectClient, startMcpHttpServer, toolText } from "./integrations/helpers.js"

function echoServer(id: string, allowedTools: string[] = [], enabled = true) {
  return {
    id,
    name: id,
    enabled,
    allowedTools,
    transport: "stdio" as const,
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      join(import.meta.dirname, "..", "scripts", "test-fixtures", "external-mcp-echo.ts"),
    ],
    env: {},
  }
}

test("empty registry starts without installing servers and rejects invalid definitions", async (t) => {
  const root = await tempDir(t, "external-mcp-empty-")
  const manager = new ExternalMcpManager(root)
  t.after(() => manager.close())
  assert.deepEqual(await manager.list(), [])
  await manager.start()
  assert.equal(serverDefinition.safeParse({ ...echoServer("bad"), command: "" }).success, false)
  assert.equal(
    serverDefinition.safeParse({
      id: "http-server",
      name: "Remote",
      enabled: false,
      allowedTools: [],
      transport: "http",
      url: "http://example.com/mcp",
    }).success,
    false
  )
  assert.equal(
    serverDefinition.safeParse({
      id: "https-server",
      name: "Remote",
      enabled: false,
      allowedTools: [],
      transport: "http",
      url: "https://example.com/mcp",
    }).success,
    true
  )
})

test("a failed external MCP connection is isolated and can recover", {
  timeout: 25_000,
}, async (t) => {
  const root = await tempDir(t, "external-mcp-failure-")
  const manager = new ExternalMcpManager(root)
  t.after(() => manager.close())
  await manager.save({ ...echoServer("broken", ["echo"]), command: "/no/such/mcp/executable" })
  await manager.save(echoServer("working", ["echo"]))
  await assert.rejects(() => manager.connect("broken"), /Failed to connect/u)
  assert.equal((await manager.list()).find((server) => server.id === "broken")?.state, "error")
  const response = await manager.call("working", "echo", { text: "isolation works" })
  assert.equal((response.content[0] as { text: string }).text, "isolation works")
  await manager.save(echoServer("broken", ["echo"]))
  const restored = await manager.call("broken", "echo", { text: "recovered" })
  assert.equal((restored.content[0] as { text: string }).text, "recovered")
})

test("stdio discovery, duplicate tool names, per-tool approvals, persistence, and shutdown", {
  timeout: 25_000,
}, async (t) => {
  const root = await tempDir(t, "external-mcp-stdio-")
  const manager = new ExternalMcpManager(root)
  t.after(() => manager.close())
  await manager.save(echoServer("first", [], false))
  await assert.rejects(() => manager.connect("first"), /disabled/u)
  await manager.save(echoServer("first"))
  await manager.save(echoServer("second", ["echo"]))
  assert.equal((await manager.list()).length, 2)
  assert.deepEqual(
    (await manager.discover("first")).map((tool) => tool.name),
    ["echo"]
  )
  assert.equal((await manager.inspect("first", "echo")).allowed, false)
  await assert.rejects(() => manager.call("first", "echo", { text: "blocked" }), /not approved/u)
  const second = await manager.call("second", "echo", { text: "second works" })
  assert.equal(second.content[0]?.type, "text")
  assert.equal((second.content[0] as { text: string }).text, "second works")
  await manager.save(echoServer("first", ["echo"]))
  const first = await manager.call("first", "echo", { text: "first works" })
  assert.equal((first.content[0] as { text: string }).text, "first works")
  const stored = await manager.registry.read()
  assert.equal(stored.servers.length, 2)
  assert.equal((await stat(manager.registry.path)).mode & 0o777, 0o600)
  await manager.disconnect("first")
  await manager.remove("second")
  assert.deepEqual(
    (await manager.list()).map((entry) => entry.id),
    ["first"]
  )
})

test("remote Streamable HTTP and three constant Shellby bridge tools", {
  timeout: 25_000,
}, async (t) => {
  const root = await tempDir(t, "external-mcp-http-")
  const manager = new ExternalMcpManager(root)
  t.after(() => manager.close())
  const downstream = await startMcpHttpServer({
    profile: {
      tools: {
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        subagents: false,
        web: false,
        skills: false,
        image: false,
        computer: false,
        review: false,
      },
    },
  })
  t.after(() => downstream.close())
  await manager.save({
    id: "local",
    name: "Local test",
    enabled: true,
    allowedTools: [],
    transport: "http",
    url: downstream.url,
  })
  const tools = await manager.discover("local")
  assert.ok(tools.some((tool) => tool.name === "start_here"))

  const running = await startMcpHttpServer({
    externalMcp: manager,
    agentObserver: createAgentObserver(),
    accessToken: "b".repeat(64),
    http: { dashboardPort: 0 },
    profile: {
      tools: {
        shell: false,
        applyPatch: false,
        fileRead: false,
        fileWrite: false,
        subagents: false,
        web: false,
        skills: false,
        image: false,
        computer: false,
        review: false,
      },
    },
  })
  t.after(() => running.close())
  const local = await connectClient(running.url, "bridge-test")
  t.after(() => local.client.close())
  const exposed = await local.client.listTools()
  assert.deepEqual(
    exposed.tools.map((tool) => tool.name),
    ["start_here", "mcp_list", "mcp_inspect", "mcp_call"]
  )
  await local.client.callTool({
    name: "start_here",
    arguments: { mode: "general", task_id: "external-mcp-bridge-test" },
  })
  const list = await local.client.callTool({ name: "mcp_list", arguments: { server: "local" } })
  assert.match(toolText(list), /start_here/u)
  const inspect = await local.client.callTool({
    name: "mcp_inspect",
    arguments: { server: "local", tool: "start_here" },
  })
  assert.match(toolText(inspect), /inputSchema/u)
  const blocked = await local.client.callTool({
    name: "mcp_call",
    arguments: {
      server: "local",
      tool: "start_here",
      arguments: { mode: "general", task_id: "x" },
    },
  })
  assert.equal(blocked.isError, true)
  assert.match(toolText(blocked), /not approved/u)

  assert.ok(running.dashboardUrl)
  const origin = new URL(running.dashboardUrl).origin
  const denied = await fetch(`${origin}/api/external-mcp/local/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://malicious.example" },
    body: "{}",
  })
  assert.equal(denied.status, 403)
  const registry = await fetch(`${origin}/api/external-mcp`)
  assert.equal(registry.status, 200)
  const allowed = await fetch(`${origin}/api/external-mcp/local`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      id: "local",
      name: "Local test",
      enabled: true,
      allowedTools: ["start_here"],
      transport: "http",
      url: downstream.url,
    }),
  })
  assert.equal(allowed.status, 200)
  const result = await local.client.callTool({
    name: "mcp_call",
    arguments: {
      server: "local",
      tool: "start_here",
      arguments: { mode: "general", task_id: "external-bridge" },
    },
  })
  assert.equal(result.isError, undefined)
  assert.match(toolText(result), /Shellby/u)
  const dashboardCall = await fetch(`${origin}/api/external-mcp/local/tools/start_here/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ arguments: { mode: "general", task_id: "dashboard-test-call" } }),
  })
  assert.equal(dashboardCall.status, 200)
  const dashboardResult: unknown = await dashboardCall.json()
  assert.ok(dashboardResult && typeof dashboardResult === "object")
  assert.equal((await fetch(`http://127.0.0.1:${running.port}/api/external-mcp`)).status, 404)
})
