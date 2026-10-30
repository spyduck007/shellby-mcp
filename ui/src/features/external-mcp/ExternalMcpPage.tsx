import { useCallback, useEffect, useState } from "react"
import { Button } from "../../components/ui/button"
import { ThemeSelect } from "../../components/ThemeSelect"
import { WorkspaceHeader } from "../../components/WorkspaceHeader"

type StdioServer = { id: string; name: string; enabled: boolean; allowedTools: string[]; transport: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, string> }
type RemoteServer = { id: string; name: string; enabled: boolean; allowedTools: string[]; transport: "http" | "sse"; url: string; bearerTokenEnv?: string }
type Server = StdioServer | RemoteServer
type Status = { id: string; name: string; transport: string; enabled: boolean; state: "connected" | "disconnected" | "error"; toolCount: number; error?: string }
type Tool = { name: string; description?: string; allowed: boolean }

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/external-mcp${path}`, options)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }
}

const blankStdio = (): StdioServer => ({ id: "", name: "", enabled: false, allowedTools: [], transport: "stdio", command: "", args: [], env: {} })

export function ExternalMcpPage() {
  const [servers, setServers] = useState<Server[]>([])
  const [status, setStatus] = useState<Status[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Server | null>(null)
  const [tools, setTools] = useState<Tool[]>([])
  const [inspected, setInspected] = useState<Record<string, unknown> | null>(null)
  const [testTool, setTestTool] = useState<string | null>(null)
  const [testArgs, setTestArgs] = useState("{}")
  const [testResult, setTestResult] = useState<unknown>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const response = await api<{ registry: Server[]; servers: Status[] }>("")
    setServers(response.registry)
    setStatus(response.servers)
  }, [])

  useEffect(() => { void refresh().catch((e: Error) => setError(e.message)) }, [refresh])

  async function execute(task: () => Promise<void>) {
    setError("")
    setBusy(true)
    try { await task(); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function selectServer(id: string, forceRefresh = false) {
    setSelected(id)
    setDraft(null)
    setInspected(null)
    setTestTool(null)
    setTestResult(null)
    setTools([])
    await execute(async () => {
      const response = await api<{ tools: Tool[] }>(`/${encodeURIComponent(id)}/tools${forceRefresh ? "?refresh=1" : ""}`)
      setTools(response.tools)
    })
  }

  async function save(definition: Server) {
    await execute(async () => {
      await api(`/${encodeURIComponent(definition.id)}`, jsonRequest("PUT", definition))
      setDraft(null)
      setSelected(definition.id)
    })
  }

  async function allowTool(tool: string, allowed: boolean) {
    const definition = servers.find((server) => server.id === selected)
    if (!definition) return
    const update = { ...definition, allowedTools: allowed ? [...definition.allowedTools, tool] : definition.allowedTools.filter((name) => name !== tool) }
    await execute(async () => {
      await api(`/${encodeURIComponent(update.id)}`, jsonRequest("PUT", update))
      setTools((old) => old.map((item) => item.name === tool ? { ...item, allowed } : item))
    })
  }

  async function allowAllTools() {
    const definition = servers.find((server) => server.id === selected)
    if (!definition || tools.length === 0) return
    const unapproved = tools.filter((tool) => !tool.allowed)
    if (unapproved.length === 0) return

    const allowedTools = [...new Set([...definition.allowedTools, ...tools.map((tool) => tool.name)])]
    if (allowedTools.length > 500) {
      setError("The server's approval list exceeds the 500-tool limit.")
      return
    }

    if (
      !window.confirm(
        `Enable ${unapproved.length} additional tools on ${definition.name} (${allowedTools.length} total)?\n\nThis grants Shellby permission to call every discovered tool, including tools that may run programs, change files, or access the network. No tools will be executed by enabling them.`
      )
    ) return

    await execute(async () => {
      await api(`/${encodeURIComponent(definition.id)}`, jsonRequest("PUT", { ...definition, allowedTools }))
      setTools((current) => current.map((tool) => ({ ...tool, allowed: true })))
    })
  }

  const active = status.find((server) => server.id === selected)
  const approvedCount = tools.filter((tool) => tool.allowed).length
  return (
    <main className="min-h-screen">
      <WorkspaceHeader title="External MCP Servers" description="Manage local and remote MCP connections" leading={<div className="flex size-10 items-center justify-center rounded-lg border bg-card">MCP</div>}>
        <ThemeSelect />
        <Button variant="outline" size="sm" onClick={() => { window.location.href = "/" }}>Dashboard</Button>
        <Button variant="outline" size="sm" onClick={() => void execute(async () => { })}>Refresh</Button>
      </WorkspaceHeader>
      <div className="mx-auto max-w-375 space-y-5 px-4 py-6 lg:px-6">
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
          External MCP servers run with the permissions you grant them. Adding a server does not approve any of its tools. This control panel is available on localhost only.
        </div>
        {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Configured servers ({servers.length})</h2>
          <Button disabled={busy} onClick={() => { setSelected(null); setTools([]); setDraft(blankStdio()) }}>Add server</Button>
        </div>
        {servers.length === 0 && <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">No external MCP servers configured. Nothing will be installed or started until you add and enable a server.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          {servers.map((server) => {
            const state = status.find((s) => s.id === server.id)
            return <div key={server.id} className="rounded-xl border bg-card p-4 shadow-card">
              <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{server.name}</h3><span className="text-xs text-muted-foreground">{state?.state ?? "disconnected"}</span></div>
              <p className="mt-1 text-xs text-muted-foreground">{server.id} · {server.transport} · {server.enabled ? "Enabled" : "Disabled"} · {state?.toolCount ?? 0} discovered tools</p>
              {state?.error && <p className="mt-2 text-xs text-destructive">{state.error}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void selectServer(server.id)}>Tools</Button>
                <Button size="sm" variant="outline" onClick={() => { setDraft({ ...server }); setSelected(server.id) }}>Edit</Button>
                <Button size="sm" variant="outline" disabled={busy || !server.enabled} onClick={() => void execute(async () => { await api(`/${encodeURIComponent(server.id)}/connect`, jsonRequest("POST")) })}>Connect</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void execute(async () => { await api(`/${encodeURIComponent(server.id)}/disconnect`, jsonRequest("POST")) })}>Disconnect</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm(`Remove server ${server.name}?`)) void execute(async () => { await api(`/${encodeURIComponent(server.id)}`, jsonRequest("DELETE")); if (selected === server.id) setSelected(null) }) }}>Remove</Button>
              </div>
            </div>
          })}
        </div>
        {draft && <ServerEditor key={draft.id} definition={draft} busy={busy} onCancel={() => setDraft(null)} onSave={(value) => void save(value)} />}
        {selected && !draft && <section className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">{selected} tools</h2>
              {tools.length > 0 && <p className="text-xs text-muted-foreground">{approvedCount} of {tools.length} tools approved</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={busy || !active?.enabled} onClick={() => void selectServer(selected, true)}>Rediscover</Button>
              <Button size="sm" disabled={busy || !active?.enabled || tools.length === 0 || approvedCount === tools.length} onClick={() => void allowAllTools()}>Enable all tools</Button>
            </div>
          </div>
          {!active?.enabled && <p className="mt-2 text-sm text-muted-foreground">Enable this server in Edit before discovering or calling tools.</p>}
          {tools.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No tools loaded yet.</p>}
          <div className="mt-3 divide-y">{tools.map((tool) => <div key={tool.name} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1"><p className="text-sm font-medium">{tool.name}</p><p className="text-xs text-muted-foreground">{tool.description ?? "No description"}</p></div>
            <Button size="sm" variant="outline" onClick={() => void execute(async () => { setInspected(await api<Record<string, unknown>>(`/${encodeURIComponent(selected)}/tools/${encodeURIComponent(tool.name)}`)) })}>Schema</Button>
            <Button size="sm" variant="outline" disabled={busy || !tool.allowed} onClick={() => { setTestTool(tool.name); setTestArgs("{}"); setTestResult(null) }}>Test</Button>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={tool.allowed} disabled={busy} onChange={(e) => void allowTool(tool.name, e.target.checked)} />Approved</label>
          </div>)}</div>
          {inspected && <pre className="mt-4 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(inspected, null, 2)}</pre>}
          {testTool && <div className="mt-4 space-y-2 rounded-lg border p-3">
            <h3 className="text-sm font-semibold">Test {testTool}</h3>
            <p className="text-xs text-muted-foreground">This executes the approved tool. Review arguments and effects before proceeding.</p>
            <label className="block text-xs">JSON arguments<textarea className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-xs" rows={4} value={testArgs} onChange={(e) => setTestArgs(e.target.value)} /></label>
            <Button size="sm" disabled={busy} onClick={() => void execute(async () => {
              const parsed: unknown = JSON.parse(testArgs)
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arguments must be a JSON object")
              setTestResult(await api(`/${encodeURIComponent(selected)}/tools/${encodeURIComponent(testTool)}/call`, jsonRequest("POST", { arguments: parsed })))
            })}>Run test</Button>
            {testResult !== null && <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(testResult, null, 2)}</pre>}
          </div>}
        </section>}
      </div>
    </main>
  )
}

function ServerEditor({ definition, busy, onSave, onCancel }: { definition: Server; busy: boolean; onSave: (value: Server) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Server>(definition)
  const [argsText, setArgsText] = useState(definition.transport === "stdio" ? definition.args.join("\n") : "")
  const inputStyle = "w-full rounded-md border bg-background px-3 py-2 text-sm"
  return <section className="rounded-xl border bg-card p-5"><h2 className="mb-4 font-semibold">{definition.id ? "Edit server" : "Add external MCP server"}</h2>
    <form className="grid gap-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); onSave(draft.transport === "stdio" ? { ...draft, args: argsText.split("\n").filter(Boolean) } : draft) }}>
      <label className="text-sm">Server ID<input required pattern="[a-z][a-z0-9_-]*" disabled={Boolean(definition.id)} className={inputStyle} value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })}/></label>
      <label className="text-sm">Display name<input required className={inputStyle} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}/></label>
      <label className="text-sm">Transport<select className={inputStyle} value={draft.transport} onChange={(e) => { const transport = e.target.value; if (transport === "stdio") setDraft({ id: draft.id, name: draft.name, enabled: draft.enabled, allowedTools: [], transport, command: "", args: [], env: {} }); else setDraft({ id: draft.id, name: draft.name, enabled: draft.enabled, allowedTools: [], transport: transport as "http" | "sse", url: "" }) }}><option value="stdio">Local stdio</option><option value="http">Streamable HTTP</option><option value="sse">Legacy SSE</option></select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}/>Enabled</label>
      {draft.transport === "stdio" ? <>
        <label className="text-sm">Executable<input required className={inputStyle} placeholder="npx / python / absolute path" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })}/></label>
        <label className="text-sm">Working directory (optional)<input className={inputStyle} value={draft.cwd ?? ""} onChange={(e) => { const { cwd: _cwd, ...rest } = draft; setDraft(e.target.value ? { ...rest, cwd: e.target.value } : rest) }}/></label>
        <label className="text-sm md:col-span-2">Arguments (one per line)<textarea className={inputStyle} rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)}/></label>
        <p className="text-xs text-muted-foreground md:col-span-2">Environment references can be configured in the local registry JSON. Store variable names, never secret values.</p>
      </> : <>
        <label className="text-sm md:col-span-2">MCP endpoint URL<input required type="url" className={inputStyle} value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })}/></label>
        <label className="text-sm md:col-span-2">Bearer token environment variable (optional)<input className={inputStyle} value={draft.bearerTokenEnv ?? ""} onChange={(e) => { const { bearerTokenEnv: _token, ...rest } = draft; setDraft(e.target.value ? { ...rest, bearerTokenEnv: e.target.value } : rest) }}/></label>
      </>}
      <div className="flex gap-2 md:col-span-2"><Button type="submit" disabled={busy}>Save server</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
    </form>
  </section>
}
