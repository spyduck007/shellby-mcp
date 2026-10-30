import { useEffect, useState } from "react"
import type { Agent } from "../../types"

/** Standard GPT-6 Sol text rates, USD per million tokens. Not actual ChatGPT billing. */
export const SOL_PRICING = {
  model: "GPT-6 Sol",
  inputPerMillion: 2,
  outputPerMillion: 10,
  cachedInputPerMillion: 0.2,
} as const

export interface TokenCounts {
  calls: number
  inputTokens: number
  outputTokens: number
  errors: number
}

export interface UsageDay extends TokenCounts {
  date: string
}

export interface UsageHistory {
  source: "audit-log"
  partial: boolean
  dateBasis: "America/Los_Angeles"
  days: UsageDay[]
  agents: Array<TokenCounts & { id: string }>
  total: TokenCounts
  firstRecordedAt?: number
  lastRecordedAt?: number
}

const zero = (): TokenCounts => ({ calls: 0, inputTokens: 0, outputTokens: 0, errors: 0 })

export function sumCounts(items: TokenCounts[]): TokenCounts {
  return items.reduce(
    (total, value) => ({
      calls: total.calls + value.calls,
      inputTokens: total.inputTokens + value.inputTokens,
      outputTokens: total.outputTokens + value.outputTokens,
      errors: total.errors + value.errors,
    }),
    zero()
  )
}

export function estimateUsd(input: number, output: number): number {
  return (
    (Math.max(0, input) * SOL_PRICING.inputPerMillion +
      Math.max(0, output) * SOL_PRICING.outputPerMillion) /
    1_000_000
  )
}

export function formatCost(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value
  )
}

function dateKey(at: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at)
  const get = (name: string) => parts.find((part) => part.type === name)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

export function recentDays(days: UsageDay[], duration: number, now: number): UsageDay[] {
  const today = dateKey(now)
  const todayDay = Date.parse(`${today}T00:00:00Z`)
  const cutoff = new Date(todayDay - (duration - 1) * 86_400_000).toISOString().slice(0, 10)
  return days.filter((day) => day.date >= cutoff && day.date <= today)
}

export function liveSessionTotals(agents: Agent[]): TokenCounts {
  return sumCounts(
    agents.map((agent) => ({
      calls: agent.toolUsage?.callCount ?? 0,
      inputTokens: agent.toolUsage?.inputTokens ?? 0,
      outputTokens: agent.toolUsage?.outputTokens ?? 0,
      errors: 0,
    }))
  )
}

export function useUsageHistory() {
  const [history, setHistory] = useState<UsageHistory | undefined>()
  const [available, setAvailable] = useState<boolean | undefined>()
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const response = await fetch("/api/usage", { cache: "no-store" })
        if (!response.ok) throw new Error(`History unavailable (${response.status})`)
        const body = (await response.json()) as UsageHistory
        if (active) {
          setHistory(body)
          setAvailable(true)
        }
      } catch {
        if (active) setAvailable(false)
      }
    }
    void load()
    const interval = window.setInterval(() => void load(), 30_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])
  return { history, available }
}
