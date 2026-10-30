const { execFileSync } = require("node:child_process")
const { join } = require("node:path")
const { loadPublicConfig } = require("./dist/public-config.cjs")

const shellbyConfig = loadPublicConfig(join(__dirname, ".shellby", "config.toml"))

const apps = [
  {
    name: "shellby-mcp",
    script: "dist/index.js",
    cwd: __dirname,
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    kill_timeout: 10_000,
  },
]

if (shellbyConfig.ngrok.enabled) {
  const ngrokExecutable = execFileSync("/usr/bin/which", ["ngrok"], { encoding: "utf8" }).trim()
  // Keep the known-good ngrok invocation. MCP access is protected by a private URL token.
  const ngrokArgs = ["http", String(shellbyConfig.port)]
  if (shellbyConfig.ngrok.url) ngrokArgs.push(`--url=${shellbyConfig.ngrok.url}`)
  ngrokArgs.push(`--host-header=localhost:${shellbyConfig.port}`)
  if (shellbyConfig.ngrok.pooling_enabled) ngrokArgs.push("--pooling-enabled")
  apps.push({
    name: "shellby-ngrok",
    script: ngrokExecutable,
    args: ngrokArgs,
    cwd: __dirname,
    interpreter: "none",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
  })
}

module.exports = {
  apps,
}
