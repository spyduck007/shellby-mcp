import { AsyncLocalStorage } from "node:async_hooks"
import { createServer, type Server as HttpServer } from "node:http"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpHandler } from "@modelcontextprotocol/server"
import type { Request, Response } from "express"
import { runWithAgent } from "../agent/context.js"
import { createDashboardRouter } from "../agent/dashboard-routes.js"
import type { AgentObserver } from "../agent/observer.js"
import { protectedMcpPath } from "../auth/mcp-access-token.js"
import { ShellbyAuthError, type ShellbyAuthStore } from "../auth/store.js"
import { MCP_CONFIG } from "../config.js"
import type { ExternalMcpManager } from "../external-mcp/manager.js"
import type { McpServerFactory } from "../mcp/server-factory.js"
import { ToolCallTracker } from "../mcp/tool-call-tracker.js"
import { asRecord } from "../utils.js"
import type { McpAuditLogger } from "./audit/audit-log.js"

const MCP_ROUTE = /^\/mcp$/u

export interface RunningMcpServer {
  host: string
  port: number
  url: string
  dashboardUrl?: string
  close: () => Promise<void>
}

export interface McpHttpServices {
  createMcpServer: McpServerFactory
  externalMcp?: ExternalMcpManager
  accessToken?: string
  auditLogger?: McpAuditLogger
  authStore?: ShellbyAuthStore
  agentObserver?: AgentObserver
}

export interface McpHttpProfileOverrides {
  host?: string
  port?: number
  instanceId?: string
  dashboardPort?: number
}

export async function startMcpHttpServer(
  services: McpHttpServices,
  profileOverrides: McpHttpProfileOverrides = {}
): Promise<RunningMcpServer> {
  const host = profileOverrides.host ?? MCP_CONFIG.host
  const port = profileOverrides.port ?? MCP_CONFIG.port
  const instanceId = profileOverrides.instanceId ?? MCP_CONFIG.instanceId
  const { createMcpServer, externalMcp, accessToken, auditLogger, authStore, agentObserver } =
    services
  const mcpPath = accessToken ? protectedMcpPath(accessToken) : "/mcp"
  const requestCalls = new AsyncLocalStorage<ToolCallTracker>()

  const app = createMcpExpressApp({ host, jsonLimit: "1mb" })
  if (accessToken) {
    // ngrok connects from loopback too, so source IP and forwarded headers cannot
    // distinguish a local request from an anonymous public request.
    app.use((req, res, next) => {
      if (req.path === "/healthz" || req.path === mcpPath) return next()
      res.sendStatus(404)
    })
  }
  const mcpHandler = createMcpHandler(
    () => createMcpServer({ calls: requestCalls.getStore(), agentObserver }),
    {
      legacy: "stateless",
      onerror: reportMcpError,
    }
  )
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: reportMcpError })

  app.get("/healthz", (_req, res) => {
    res.setHeader("x-shellby-instance", instanceId)
    res.json({ ok: true })
  })

  const handleMcpRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = requestSessionId(req)
    await runWithAgent(sessionId, async () => {
      const calls = new ToolCallTracker({ auditLogger, agentObserver })
      calls.startRequest(req.body)
      res.once("finish", () =>
        calls.finishRequest({ httpStatus: res.statusCode, state: "finished" })
      )
      res.once("close", () => calls.finishRequest({ httpStatus: res.statusCode, state: "closed" }))
      await requestCalls.run(calls, () => nodeMcpHandler(req, res, req.body))
    })
  }

  app.all(accessToken ? mcpPath : MCP_ROUTE, async (req: Request, res: Response) => {
    if (
      req.method === "POST" &&
      authStore &&
      isTrustedRemoteRequest(req) &&
      containsToolCall(req.body)
    ) {
      try {
        await authStore.authorizeToolCall(req.get("x-openai-subject"))
      } catch (error) {
        remoteAuthError(res, error)
        return
      }
    }
    await handleMcpRequest(req, res)
  })

  // A protected MCP port can be reached through ngrok, even when it binds to
  // loopback. Serve the dashboard separately so it is never on that tunnel.
  if (agentObserver && !accessToken) app.use(createDashboardRouter(agentObserver, externalMcp))

  const httpServer = createServer(app)
  let boundPort: number
  let dashboardServer: HttpServer | undefined
  let dashboardUrl: string | undefined
  try {
    await listen(httpServer, port, host)

    const address = httpServer.address()
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address.")
    }
    boundPort = address.port

    if (agentObserver && accessToken) {
      const localPort = profileOverrides.dashboardPort ?? (port === 0 ? 0 : port + 1)
      const dashboard = await startLocalDashboard(agentObserver, localPort, externalMcp)
      dashboardServer = dashboard.server
      dashboardUrl = dashboard.url
    } else if (agentObserver) {
      dashboardUrl = `http://${host}:${boundPort}/`
    }
  } catch (error) {
    const httpClose = closeHttpServerIfListening(httpServer)
    await Promise.allSettled([
      mcpHandler.close(),
      httpClose,
      ...(dashboardServer ? [closeHttpServerIfListening(dashboardServer)] : []),
    ])
    throw error
  }

  let closed = false
  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}${mcpPath}`,
    dashboardUrl,
    close: async () => {
      if (closed) return
      closed = true
      await Promise.allSettled([
        mcpHandler.close(),
        closeHttpServerIfListening(httpServer),
        ...(dashboardServer ? [closeHttpServerIfListening(dashboardServer)] : []),
      ])
    },
  }
}

async function startLocalDashboard(
  observer: AgentObserver,
  port: number,
  externalMcp?: ExternalMcpManager
): Promise<{ server: HttpServer; url: string }> {
  const host = "127.0.0.1"
  const app = createMcpExpressApp({ host, jsonLimit: "1mb" })
  app.use(createDashboardRouter(observer, externalMcp))
  const server = createServer(app)
  try {
    await listen(server, port, host)
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("Dashboard server did not expose a TCP address.")
    }
    return { server, url: `http://${host}:${address.port}/` }
  } catch (error) {
    await closeHttpServerIfListening(server)
    throw error
  }
}

function containsToolCall(payload: unknown): boolean {
  const requests = Array.isArray(payload) ? payload : [payload]
  return requests.some((value) => {
    const request = asRecord(value)
    if (request?.method !== "tools/call") return false
    const params = asRecord(request.params)
    return typeof params?.name === "string" && params.name.length > 0
  })
}

function isTrustedRemoteRequest(req: Request): boolean {
  return req.get("x-shellby-remote") === "1"
}

function requestSessionId(req: Request): string | undefined {
  const value = req.get("x-openai-session")?.trim()
  return value || undefined
}

function reportMcpError(error: Error): void {
  console.error("MCP handler error:", error)
}

function remoteAuthError(res: Response, error: unknown): void {
  if (error instanceof ShellbyAuthError) {
    if (error.code === "subject_missing" || error.code === "subject_mismatch") {
      jsonRpcError(res, 403, -32002, "Remote MCP access denied.")
      return
    }
    jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
    return
  }

  console.error("Remote MCP authentication failed:", error)
  jsonRpcError(res, 503, -32003, "Remote MCP authentication is unavailable.")
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  })
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

function closeHttpServerIfListening(server: HttpServer): Promise<void> {
  return server.listening ? closeHttpServer(server) : Promise.resolve()
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}
