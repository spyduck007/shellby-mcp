import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u)
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
const shared = {
  id: identifier,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(false),
  allowedTools: z.array(z.string().min(1)).max(500).default([]),
}

const stdio = z
  .object({
    ...shared,
    transport: z.literal("stdio"),
    command: z.string().trim().min(1),
    args: z.array(z.string()).max(100).default([]),
    cwd: z.string().optional(),
    env: z.record(environmentName, environmentName).default({}),
  })
  .strict()
const remote = z
  .object({
    ...shared,
    transport: z.enum(["http", "sse"]),
    url: z.url().refine((value) => {
      const u = new URL(value)
      return (
        u.protocol === "https:" ||
        (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
      )
    }, "Remote MCP requires HTTPS (except loopback)"),
    bearerTokenEnv: environmentName.optional(),
  })
  .strict()

export const serverDefinition = z.discriminatedUnion("transport", [stdio, remote])
export type ExternalServerDefinition = z.infer<typeof serverDefinition>
const registrySchema = z
  .object({ version: z.literal(1), servers: z.array(serverDefinition).max(50) })
  .strict()
  .superRefine((registry, ctx) => {
    const ids = new Set<string>()
    for (const server of registry.servers) {
      if (ids.has(server.id))
        ctx.addIssue({ code: "custom", message: `Duplicate server id: ${server.id}` })
      ids.add(server.id)
    }
  })
export type ExternalRegistry = z.infer<typeof registrySchema>

export class ExternalMcpRegistry {
  readonly path: string
  private tail: Promise<unknown> = Promise.resolve()
  constructor(stateDir: string) {
    this.path = join(stateDir, "external-mcp.json")
  }

  async read(): Promise<ExternalRegistry> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"))
      return registrySchema.parse(parsed)
    } catch (error) {
      if (isFileError(error, "ENOENT")) return { version: 1, servers: [] }
      throw error
    }
  }

  async save(server: unknown): Promise<ExternalRegistry> {
    const definition = serverDefinition.parse(server)
    return this.mutate((registry) => {
      const index = registry.servers.findIndex((entry) => entry.id === definition.id)
      if (index === -1) registry.servers.push(definition)
      else registry.servers[index] = definition
      return registry
    })
  }

  async remove(id: string): Promise<ExternalRegistry> {
    identifier.parse(id)
    return this.mutate((registry) => {
      registry.servers = registry.servers.filter((entry) => entry.id !== id)
      return registry
    })
  }

  private async mutate(
    change: (registry: ExternalRegistry) => ExternalRegistry
  ): Promise<ExternalRegistry> {
    const task = this.tail
      .catch(() => undefined)
      .then(async () => {
        const registry = registrySchema.parse(change(await this.read()))
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
            mode: 0o600,
            flag: "wx",
          })
          await rename(temporary, this.path)
          await chmod(this.path, 0o600)
        } finally {
          const { rm } = await import("node:fs/promises")
          await rm(temporary, { force: true })
        }
        return registry
      })
    this.tail = task
    return task
  }
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
