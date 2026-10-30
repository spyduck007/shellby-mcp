import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import test from "node:test"
import express from "express"
import { createDashboardRouter } from "../src/agent/dashboard-routes.js"
import { createAgentObserver } from "../src/agent/observer.js"
import { parseAuditUsage } from "../src/agent/usage-analytics.js"
import { tempDir } from "./helpers/temp.js"

test("usage history counts token metadata without exposing audit contents", () => {
  const text = [
    "--- # shell_run - 50ms - 100 in / 250 out - Oct 29 11:30 PM",
    "session: agent-1/first-task",
    "command: very private content that should not leave the server",
    "",
    "--- # ! mcp_call - 50ms - 10 in / 20 out - Oct 30 7:00 AM",
    "session: agent-2/research",
    "error: private error message",
    "",
    "--- # tools/list - Oct 30 7:01 AM",
  ].join("\n")
  const result = parseAuditUsage(text, Date.UTC(2026, 9, 30, 21))
  assert.equal(result.total.calls, 2)
  assert.equal(result.total.inputTokens, 110)
  assert.equal(result.total.outputTokens, 270)
  assert.equal(result.total.errors, 1)
  assert.equal(result.days.length, 2)
  assert.equal(result.agents.find((agent) => agent.id === "agent-1")?.calls, 1)
  assert.equal(result.agents.find((agent) => agent.id === "agent-2")?.errors, 1)
  assert.doesNotMatch(JSON.stringify(result), /private/iu)
})

test("usage history handles year rollover and unknown token counts", () => {
  const text = [
    "--- # shell_run - 10ms - 3 in / 5 out - Dec 31 11:55 PM",
    "session: agent-1/task",
    "--- # shell_run - 12ms - ? in / ? out - Jan 1 1:05 AM",
    "session: agent-1/task",
  ].join("\n")
  const result = parseAuditUsage(text, Date.UTC(2027, 0, 2))
  assert.deepEqual(
    result.days.map((day) => day.date),
    ["2026-12-31", "2027-01-01"]
  )
  assert.equal(result.total.inputTokens, 3)
  assert.equal(result.total.outputTokens, 5)
  assert.equal(result.total.calls, 2)
})

test("dashboard usage API exposes only audit metadata, not private commands", async (t) => {
  const root = await tempDir(t, "usage-analytics-http-")
  const path = join(root, "audit.yaml")
  await writeFile(
    path,
    [
      "--- # shell_run - 40ms - 25 in / 50 out - Oct 30 9:00 AM",
      "session: agent-1/private-task",
      "command: SECRET_COMMAND_NOT_FOR_BROWSER",
      "response: SECRET_RESPONSE_NOT_FOR_BROWSER",
    ].join("\n")
  )
  const app = express()
  app.use(createDashboardRouter(createAgentObserver(), undefined, path))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const response = await fetch(`http://127.0.0.1:${address.port}/api/usage`)
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.doesNotMatch(body, /SECRET_COMMAND|SECRET_RESPONSE|private-task/u)
  const parsed = JSON.parse(body) as {
    total: { calls: number; inputTokens: number; outputTokens: number }
  }
  assert.equal(parsed.total.calls, 1)
  assert.equal(parsed.total.inputTokens, 25)
  assert.equal(parsed.total.outputTokens, 50)
})
