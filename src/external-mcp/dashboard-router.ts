import { type Request, type Response, Router } from "express"
import { z } from "zod"
import type { ExternalMcpManager } from "./manager.js"
import { serverDefinition } from "./registry.js"

/** Mount on Shellby's local-only dashboard listener, never its ngrok-facing MCP port. */
export function createExternalMcpDashboardRouter(manager: ExternalMcpManager): Router {
  const router = Router()

  router.use("/api/external-mcp", (req, res, next) => {
    if (req.get("sec-fetch-site") === "cross-site")
      return res.status(403).json({ error: "Cross-site dashboard access denied." })
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next()
    if (!isLocalDashboardMutation(req))
      return res
        .status(403)
        .json({ error: "Dashboard changes require a same-origin JSON request." })
    next()
  })

  router.get("/api/external-mcp", async (_req, res) => {
    await respond(res, async () => ({
      servers: await manager.list(),
      registry: (await manager.registry.read()).servers,
    }))
  })

  router.get("/api/external-mcp/:id/tools", async (req, res) => {
    await respond(res, async () => ({
      tools: await manager.discover(req.params.id, undefined, req.query.refresh === "1"),
    }))
  })

  router.get("/api/external-mcp/:id/tools/:name", async (req, res) => {
    await respond(res, async () => manager.inspect(req.params.id, req.params.name))
  })

  router.put("/api/external-mcp/:id", async (req, res) => {
    await respond(res, async () => {
      const definition = serverDefinition.parse(req.body)
      if (definition.id !== req.params.id) throw new Error("Server id must match the URL")
      await manager.save(definition)
      return { ok: true }
    })
  })

  router.delete("/api/external-mcp/:id", async (req, res) => {
    await respond(res, async () => {
      await manager.remove(req.params.id)
      return { ok: true }
    })
  })

  router.post("/api/external-mcp/:id/:action", async (req, res) => {
    await respond(res, async () => {
      if (req.params.action === "connect") await manager.connect(req.params.id)
      else if (req.params.action === "disconnect") await manager.disconnect(req.params.id)
      else throw new Error("Unsupported server action")
      return { ok: true }
    })
  })
  router.post("/api/external-mcp/:id/tools/:name/call", async (req, res) => {
    await respond(res, async () => {
      const input = z
        .object({
          arguments: z.record(z.string(), z.unknown()),
          timeout_ms: z.number().int().min(100).max(120_000).optional(),
        })
        .parse(req.body)
      return manager.call(
        req.params.id,
        req.params.name,
        input.arguments,
        undefined,
        input.timeout_ms
      )
    })
  })
  return router
}

function isLocalDashboardMutation(req: Request): boolean {
  if (!req.is("application/json")) return false
  if (req.get("sec-fetch-site") === "cross-site") return false
  const origin = req.get("origin")
  if (!origin) return false
  try {
    const url = new URL(origin)
    return (
      url.protocol === "http:" &&
      url.host === req.get("host") &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
  } catch {
    return false
  }
}

async function respond(res: Response, operation: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await operation())
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message.slice(0, 400) : "External MCP operation failed",
    })
  }
}
