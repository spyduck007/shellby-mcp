import { useEffect, useMemo, useState } from "react"
import type { Agent } from "../../types"
import { SteerComposer } from "./SteerComposer"
import { ToolCallList } from "./ToolCallList"
import {
  estimateUsd,
  formatCost,
  formatCount,
  liveSessionTotals,
  recentDays,
  SOL_PRICING,
  sumCounts,
  useUsageHistory,
} from "./usage"

type Period = 1 | 7 | 30

function agentTitle(agent: Agent): string {
  return agent.taskSlug?.replace(/[-_]/gu, " ") ?? agent.id
}

function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function DetailPane({
  agent,
  all,
  now,
  close,
  openAgent,
  onDismissInstruction,
}: {
  agent: Agent
  all: Agent[]
  now: number
  close: () => void
  openAgent: (id: string) => void
  onDismissInstruction: (agent: Agent, instructionId: string) => void
}) {
  const totals = agent.toolUsage
  const estimate = estimateUsd(totals?.inputTokens ?? 0, totals?.outputTokens ?? 0)
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("keydown", keydown)
    return () => document.removeEventListener("keydown", keydown)
  }, [close])

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close()
    }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`Agent details: ${agent.id}`}
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l bg-background shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b px-6 py-5">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
              <span>Agent detail</span><span className="text-border">/</span><span>{agent.id}</span>
            </div>
            <h2 className="break-words text-xl font-semibold tracking-tight">{agentTitle(agent)}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {now - agent.lastSeenAt < 30_000 ? "Active" : "Idle"} · First observed {new Date(agent.firstSeenAt).toLocaleString()}
            </p>
          </div>
          <button type="button" onClick={close} aria-label="Close agent details" className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">Close <span aria-hidden>×</span></button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Tool calls", value: (totals?.callCount ?? 0).toLocaleString() },
              { label: "Input tokens", value: formatCount(totals?.inputTokens ?? 0) },
              { label: "Output tokens", value: formatCount(totals?.outputTokens ?? 0) },
              { label: "Estimated value", value: formatCost(estimate) },
            ].map((stat) => (
              <div key={stat.label} className="rounded-lg border bg-card p-3">
                <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                <p className="mt-2 font-mono text-lg font-semibold tabular-nums">{stat.value}</p>
              </div>
            ))}
          </div>
          {agent.parentId && all.some((candidate) => candidate.id === agent.parentId) && (
            <button type="button" className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={() => openAgent(agent.parentId!)}>
              View parent: {agent.parentId}
            </button>
          )}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-semibold">Activity</h3>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-muted-foreground">Last activity</dt><dd className="mt-1">{timeAgo(agent.lastSeenAt, now)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Current tool</dt><dd className="mt-1 truncate font-mono text-xs">{agent.current?.tool ?? "None"}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Session</dt><dd className="mt-1 font-mono text-xs">{agent.id}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Children</dt><dd className="mt-1">{all.filter((other) => other.parentId === agent.id).length}</dd></div>
            </dl>
          </div>
          <div className="grid min-h-72 gap-3 sm:grid-cols-2">
            <ToolCallList key={agent.id} agent={agent} />
            <SteerComposer key={agent.id} agent={agent} onDismissInstruction={(id) => onDismissInstruction(agent, id)} />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Costs are estimates using GPT-6 Sol standard text rates. Counts cover Shellby MCP tool payloads, not all model tokens, cached input, or actual account charges.
          </p>
        </div>
      </section>
    </div>
  )
}

export function OperationsOverview({
  agents,
  now,
  onDismissInstruction,
}: {
  agents: Agent[]
  now: number
  onDismissInstruction: (agent: Agent, instructionId: string) => void
}) {
  const { history, available } = useUsageHistory()
  const [period, setPeriod] = useState<Period>(7)
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("agent") ?? undefined
  )
  useEffect(() => {
    const handle = () => setSelectedId(new URLSearchParams(window.location.search).get("agent") ?? undefined)
    window.addEventListener("popstate", handle)
    return () => window.removeEventListener("popstate", handle)
  }, [])
  const all = useMemo(() => [...agents].sort((a, b) => b.lastSeenAt - a.lastSeenAt), [agents])
  const selected = all.find((agent) => agent.id === selectedId)
  const live = liveSessionTotals(all)
  const today = history ? sumCounts(recentDays(history.days, 1, now)) : undefined
  const week = history ? sumCounts(recentDays(history.days, 7, now)) : undefined
  const month = history ? sumCounts(recentDays(history.days, 30, now)) : undefined
  const chosen = period === 1 ? today : period === 7 ? week : month
  const chartDays = history ? recentDays(history.days, 14, now) : []
  const chartMax = Math.max(...chartDays.map((day) => estimateUsd(day.inputTokens, day.outputTokens)), 0.0001)
  const active = all.filter((agent) => now - agent.lastSeenAt < 30_000).length
  const toolCounts = new Map<string, number>()
  for (const agent of all) {
    for (const call of agent.recent) toolCounts.set(call.tool, (toolCounts.get(call.tool) ?? 0) + 1)
  }
  const commonTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

  function navigateAgent(id?: string) {
    const url = new URL(window.location.href)
    if (id) url.searchParams.set("agent", id)
    else url.searchParams.delete("agent")
    window.history.pushState(null, "", url)
    setSelectedId(id)
  }

  return (
    <div className="mb-8 space-y-6">
      <section aria-label="Usage overview">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Operations / Overview</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">Usage at a glance</h2>
          </div>
          <div className="text-right text-xs leading-5 text-muted-foreground">
            <p>GPT-6 Sol equivalent · Standard rates</p>
            <p>Estimated tool payload cost, not billed spend</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[
            { label: "Today", stats: today, note: "Pacific calendar day" },
            { label: "Past 7 days", stats: week, note: "Rolling window" },
            { label: "Past 30 days", stats: month, note: "Rolling window" },
            { label: "Current MCP session", stats: live, note: "Since service startup" },
          ].map(({ label, stats, note }) => (
            <div key={label} className="rounded-xl border bg-card px-4 py-4">
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
              <p className="mt-2 font-mono text-[clamp(1.35rem,2vw,1.9rem)] font-semibold tracking-tight tabular-nums">
                {stats ? formatCost(estimateUsd(stats.inputTokens, stats.outputTokens)) : "—"}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{stats ? `${formatCount(stats.calls)} calls · ${formatCount(stats.inputTokens + stats.outputTokens)} tokens` : "History loads after safe restart"}</p>
              <p className="mt-1 text-[10px] text-muted-foreground/75">{note}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(290px,1fr)]">
        <section aria-label="Usage trend" className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Usage trend</h3>
              <p className="mt-1 text-xs text-muted-foreground">Estimated cost based on captured MCP tool tokens</p>
            </div>
            <div className="flex items-center rounded-md border bg-surface p-0.5" aria-label="Usage period">
              {([1, 7, 30] as const).map((value) => (
                <button key={value} type="button" aria-pressed={period === value}
                  onClick={() => setPeriod(value)}
                  className={`rounded px-2.5 py-1 text-xs ${period === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}>
                  {value === 1 ? "Today" : `${value}d`}
                </button>
              ))}
            </div>
          </div>
          {history ? (
            <>
              <div className="mt-5 flex items-baseline gap-3">
                <p className="font-mono text-2xl font-semibold tabular-nums">{formatCost(estimateUsd(chosen?.inputTokens ?? 0, chosen?.outputTokens ?? 0))}</p>
                <p className="text-xs text-muted-foreground">{formatCount(chosen?.calls ?? 0)} recorded calls</p>
              </div>
              <div className="mt-4 flex h-28 items-end gap-1.5 border-b pb-1" aria-label="Daily estimated cost chart">
                {chartDays.length === 0 ? <div className="self-center text-xs text-muted-foreground">No recorded activity in the past 14 days.</div> : chartDays.map((day) => {
                  const cost = estimateUsd(day.inputTokens, day.outputTokens)
                  return <div key={day.date} className="group relative flex h-full min-w-0 flex-1 items-end" title={`${day.date}: ${formatCost(cost)} estimated · ${day.calls} calls`}>
                    <div className="w-full rounded-t-sm bg-foreground/65 transition-colors group-hover:bg-foreground" style={{ height: `${Math.max(3, cost / chartMax * 100)}%` }} />
                  </div>
                })}
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-muted-foreground"><span>{chartDays[0]?.date ?? "—"}</span><span>{chartDays.at(-1)?.date ?? "—"}</span></div>
              {history.partial && <p className="mt-3 text-xs text-amber-600">Partial history: older audit entries were not included.</p>}
            </>
          ) : (
            <div className="mt-5 flex h-40 flex-col items-center justify-center rounded-lg border border-dashed px-5 text-center">
              <p className="text-sm font-medium">Historical data pending</p>
              <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">Live agent totals work now. Day, week, and month history will appear after the updated analytics endpoint loads during the next safe MCP restart.</p>
            </div>
          )}
          <p className="mt-4 border-t pt-3 text-[11px] leading-5 text-muted-foreground">
            Pricing assumption: ${SOL_PRICING.inputPerMillion}/M input and ${SOL_PRICING.outputPerMillion}/M output. Cached input, model thinking, non-tool text, and other fees are not measured. {available === false ? "Historical API not yet active." : ""}
          </p>
        </section>

        <section aria-label="Live activity" className="rounded-xl border bg-card p-5">
          <h3 className="text-sm font-semibold">Live activity</h3>
          <p className="mt-1 text-xs text-muted-foreground">Current process · updates automatically</p>
          <div className="mt-5 grid grid-cols-3 gap-2 border-b pb-5">
            {[
              { label: "Active", value: active },
              { label: "Observed", value: all.length },
              { label: "Tool calls", value: live.calls },
            ].map((item) => (
              <div key={item.label}>
                <p className="font-mono text-2xl font-semibold tabular-nums">{formatCount(item.value)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{item.label}</p>
              </div>
            ))}
          </div>
          <h4 className="mt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recent tool mix</h4>
          <div className="mt-3 space-y-3">
            {commonTools.length === 0 ? <p className="text-xs text-muted-foreground">No recent calls.</p> : commonTools.map(([name, count]) => (
              <div key={name} className="flex items-center gap-3 text-xs">
                <span className="w-28 shrink-0 truncate font-mono" title={name}>{name}</span>
                <div className="h-1.5 flex-1 rounded-full bg-muted"><div className="h-full rounded-full bg-foreground/65" style={{ width: `${count / commonTools[0]![1] * 100}%` }} /></div>
                <span className="w-7 text-right font-mono tabular-nums text-muted-foreground">{count}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section aria-label="Agent directory" className="overflow-hidden rounded-xl border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold">Agents</h3>
            <p className="mt-1 text-xs text-muted-foreground">Select an agent to inspect its work, tool calls, and usage.</p>
          </div>
          <span className="font-mono text-xs text-muted-foreground">{all.length} observed</span>
        </div>
        <div className="hidden grid-cols-[minmax(0,1.8fr)_90px_90px_95px_95px] gap-3 border-b bg-muted/30 px-5 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:grid">
          <span>Agent / Task</span><span>Status</span><span>Calls</span><span>Tokens</span><span>Est. value</span>
        </div>
        <div className="max-h-80 divide-y overflow-y-auto">
          {all.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">No agents have connected yet.</p>
          ) : all.map((agent) => {
            const isActive = now - agent.lastSeenAt < 30_000
            return (
              <button key={`${agent.id}-${agent.firstSeenAt}`} type="button"
                aria-label={`Open agent ${agent.id}`}
                onClick={() => navigateAgent(agent.id)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground sm:grid-cols-[minmax(0,1.8fr)_90px_90px_95px_95px]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{agentTitle(agent)}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{agent.id}{agent.parentId ? ` · child of ${agent.parentId}` : ""}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={`size-1.5 rounded-full ${isActive ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
                  {isActive ? "Active" : "Idle"}
                </span>
                <span className="hidden font-mono text-xs tabular-nums sm:block">{agent.toolUsage?.callCount?.toLocaleString() ?? "—"}</span>
                <span className="hidden font-mono text-xs tabular-nums sm:block">{formatCount((agent.toolUsage?.inputTokens ?? 0) + (agent.toolUsage?.outputTokens ?? 0))}</span>
                <span className="hidden font-mono text-xs tabular-nums sm:block">{formatCost(estimateUsd(agent.toolUsage?.inputTokens ?? 0, agent.toolUsage?.outputTokens ?? 0))}</span>
              </button>
            )
          })}
        </div>
      </section>
      {selected && (
        <DetailPane
          key={`${selected.id}-${selected.firstSeenAt}`}
          agent={selected}
          all={all}
          now={now}
          close={() => navigateAgent()}
          openAgent={navigateAgent}
          onDismissInstruction={onDismissInstruction}
        />
      )}
    </div>
  )
}
