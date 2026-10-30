import assert from "node:assert/strict"
import { stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { createAgentObserver } from "../src/agent/observer.js"
import {
  ensureMcpAccessToken,
  mcpAccessTokenPath,
  protectedMcpPath,
} from "../src/auth/mcp-access-token.js"
import { ShellbyAuthStore } from "../src/auth/store.js"
import { tempDir } from "./helpers/temp.js"
import { connectClient, postWithHost, startMcpHttpServer } from "./integrations/helpers.js"

test("MCP access token is private, persistent, and rejects invalid state", async (t) => {
  const root = await tempDir(t, "shellby-access-token-")
  const first = await ensureMcpAccessToken(root)
  assert.match(first, /^[a-f0-9]{64}$/u)
  assert.equal(await ensureMcpAccessToken(root), first)
  assert.equal((await stat(mcpAccessTokenPath(root))).mode & 0o777, 0o600)
  assert.equal(protectedMcpPath(first), `/mcp/${first}`)

  await writeFile(mcpAccessTokenPath(root), "invalid\n")
  await assert.rejects(() => ensureMcpAccessToken(root), /Invalid MCP access token/u)
})

test("protected MCP accepts only its private URL, not public or spoofed paths", async (t) => {
  const root = await tempDir(t, "shellby-access-gate-")
  const accessToken = await ensureMcpAccessToken(root)
  const authStore = new ShellbyAuthStore(join(root, "auth.json"))
  await authStore.ensureState()
  const running = await startMcpHttpServer({
    accessToken,
    authStore,
    agentObserver: createAgentObserver(),
    http: { dashboardPort: 0 },
  })
  t.after(() => running.close())

  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "access-gate-test", version: "1" },
    },
  }
  const base = `http://127.0.0.1:${running.port}`
  assert.equal(await postWithHost(`${base}/mcp`, `localhost:${running.port}`, initialize), 404)
  assert.equal(
    (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shellby-remote": "1",
          "x-openai-subject": "owner",
        },
        body: JSON.stringify(initialize),
      })
    ).status,
    404,
    "spoofing the old trusted-proxy header must not bypass the private URL"
  )
  assert.equal(
    await postWithHost(`${base}/mcp/${"0".repeat(64)}`, `localhost:${running.port}`, initialize),
    404
  )
  assert.equal(
    (await fetch(`${base}/`, { headers: { "x-shellby-remote": "1" } })).status,
    404,
    "the dashboard must not be reachable from the public tunnel"
  )
  assert.equal((await fetch(`${base}/api/agents`)).status, 404)
  assert.ok(running.dashboardUrl)
  assert.equal(new URL(running.dashboardUrl).hostname, "127.0.0.1")
  const localDashboard = await fetch(new URL("api/agents", running.dashboardUrl))
  assert.equal(localDashboard.status, 200)
  assert.deepEqual(await localDashboard.json(), { agents: [] })
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  assert.equal((await authStore.readState()).subject, null)

  const client = await connectClient(running.url, "private-url-owner")
  t.after(() => client.client.close())
  assert.ok((await client.client.callTool({ name: "shell_list", arguments: {} })).content)
})
