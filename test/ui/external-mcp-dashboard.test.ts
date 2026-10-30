import assert from "node:assert/strict"
import { createServer } from "node:http"
import process from "node:process"
import test from "node:test"
import express from "express"
import { chromium } from "playwright-core"
import { createDashboardRouter } from "../../src/agent/dashboard-routes.js"
import { createAgentObserver } from "../../src/agent/observer.js"
import { ExternalMcpManager } from "../../src/external-mcp/manager.js"
import { tempDir } from "../helpers/temp.js"

test("dashboard configures external MCP servers without launching one", {
  skip: process.env.RUN_UI_TESTS !== "1",
  timeout: 30_000,
}, async (t) => {
  const root = await tempDir(t, "shellby-mcp-ui-")
  const manager = new ExternalMcpManager(root)
  t.after(() => manager.close())

  const app = express()
  app.use(express.json())
  app.use(createDashboardRouter(createAgentObserver(), manager))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  )
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const base = `http://127.0.0.1:${address.port}`

  const browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto(`${base}/external-mcp`)
  await page.getByRole("heading", { name: "External MCP Servers" }).waitFor()
  await page.getByText("No external MCP servers configured.", { exact: false }).waitFor()
  await page.getByRole("button", { name: "Add server" }).click()
  await page.getByLabel("Server ID").fill("example")
  await page.getByLabel("Display name").fill("Example test server")
  await page.getByLabel("Executable").fill("/usr/bin/false")
  await page.getByRole("button", { name: "Save server" }).click()
  await page.getByText("Example test server").waitFor()
  assert.equal((await manager.list())[0]?.state, "disconnected")
  assert.equal((await manager.list())[0]?.enabled, false)
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Remove" }).click()
  await page.getByText("No external MCP servers configured.", { exact: false }).waitFor()
  assert.deepEqual(await manager.list(), [])
})
