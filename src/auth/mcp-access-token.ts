import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u

export function mcpAccessTokenPath(stateDir: string): string {
  return join(stateDir, "mcp-access-token")
}

export function protectedMcpPath(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid MCP access token.")
  return `/mcp/${token}`
}

/** A private capability URL for ChatGPT connections configured with No Auth. */
export async function ensureMcpAccessToken(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = mcpAccessTokenPath(stateDir)
  let token: string
  try {
    token = (await readFile(path, "utf8")).trim()
  } catch (error) {
    if (!isNotFound(error)) throw error
    token = randomBytes(32).toString("hex")
    try {
      await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" })
    } catch (writeError) {
      if (!isFileExists(writeError)) throw writeError
      token = (await readFile(path, "utf8")).trim()
    }
  }
  protectedMcpPath(token)
  await chmod(path, 0o600)
  return token
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}
