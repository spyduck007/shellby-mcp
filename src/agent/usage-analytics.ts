import { readFile, stat } from "node:fs/promises"

export interface TokenTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  errors: number
}

export interface UsageDay extends TokenTotals {
  date: string
}

export interface UsageAgent extends TokenTotals {
  id: string
}

export interface UsageAnalytics {
  days: UsageDay[]
  agents: UsageAgent[]
  total: TokenTotals
  source: "audit-log"
  partial: boolean
  /** Audit logs omit year and use Pacific timestamps; dates are best effort. */
  dateBasis: "America/Los_Angeles"
  firstRecordedAt?: number
  lastRecordedAt?: number
}

const EMPTY = (): TokenTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, errors: 0 })
const MAX_AUDIT_BYTES = 24 * 1024 * 1024
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const HEADER =
  /^--- # (?:(?<flag>[!~]) )?(?<tool>[\w/-]+) - (?<duration>\d+)ms - (?<input>\d+|\?) in(?: \/ (?<output>\d+|\?) out)?(?: - HTTP \d+ \w+)? - (?<month>[A-Z][a-z]{2}) (?<day>\d{1,2}) (?<hour>\d{1,2}):(?<minute>\d{2}) (?<ampm>AM|PM)$/u
const OFFSET = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u
const LINES = /\r?\n/u
const TRIM_QUOTES = /^["']|["']$/gu

function add(target: TokenTotals, input: number, output: number, failed: boolean): void {
  target.calls += 1
  target.inputTokens += input
  target.outputTokens += output
  if (failed) target.errors += 1
}

function pacificOffsetMs(at: number): number {
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "shortOffset",
    })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT-8"
  const match = OFFSET.exec(name)
  if (!match) return -8 * 3_600_000
  const magnitude = (Number(match[2]) * 60 + Number(match[3] ?? "0")) * 60_000
  return match[1] === "+" ? magnitude : -magnitude
}

function parsePacificTimestamp(groups: Record<string, string>, referenceYear: number): number {
  const month = MONTHS.indexOf(groups.month ?? "")
  const day = Number(groups.day)
  const hour = (Number(groups.hour) % 12) + (groups.ampm === "PM" ? 12 : 0)
  const minute = Number(groups.minute)
  const local = Date.UTC(referenceYear, month, day, hour, minute)
  return local - pacificOffsetMs(local)
}

function dateKeyPacific(at: number): string {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at)
  const year = values.find((value) => value.type === "year")?.value
  const month = values.find((value) => value.type === "month")?.value
  const day = values.find((value) => value.type === "day")?.value
  return `${year}-${month}-${day}`
}

function nextPacificTimestamp(
  data: Record<string, string>,
  year: number,
  previousAt: number | undefined,
  modifiedAt: number
): { at: number; year: number } {
  let inferredYear = year
  let at = parsePacificTimestamp(data, inferredYear)
  if (previousAt !== undefined && at < previousAt - 180 * 86_400_000) {
    inferredYear += 1
    at = parsePacificTimestamp(data, inferredYear)
  } else if (previousAt === undefined && at > modifiedAt + 7 * 86_400_000) {
    inferredYear -= 1
    at = parsePacificTimestamp(data, inferredYear)
  }
  return { at, year: inferredYear }
}

/** Parse metadata only. Never parse or return command inputs, arguments, or responses. */
export function parseAuditUsage(contents: string, modifiedAt: number): UsageAnalytics {
  const total = EMPTY()
  const byDay = new Map<string, UsageDay>()
  const byAgent = new Map<string, UsageAgent>()
  let firstRecordedAt: number | undefined
  let lastRecordedAt: number | undefined
  let lastHeader: { at: number; input: number; output: number; failed: boolean } | undefined
  let year = new Date(modifiedAt).getUTCFullYear()
  let previousAt: number | undefined

  function commit(): void {
    if (!lastHeader) return
    const { at, input, output, failed } = lastHeader
    add(total, input, output, failed)
    const date = dateKeyPacific(at)
    const daily = byDay.get(date) ?? { ...EMPTY(), date }
    add(daily, input, output, failed)
    byDay.set(date, daily)
    if (lastAgent) {
      const agent = byAgent.get(lastAgent) ?? { ...EMPTY(), id: lastAgent }
      add(agent, input, output, failed)
      byAgent.set(lastAgent, agent)
    }
    firstRecordedAt = firstRecordedAt === undefined ? at : Math.min(firstRecordedAt, at)
    lastRecordedAt = lastRecordedAt === undefined ? at : Math.max(lastRecordedAt, at)
    lastHeader = undefined
    lastAgent = undefined
  }
  let lastAgent: string | undefined

  for (const line of contents.split(LINES)) {
    if (line.startsWith("--- # ")) {
      commit()
      const match = HEADER.exec(line)
      if (!match?.groups) continue
      const data = match.groups
      // Legacy headings omit year. Infer rollover from recorded order.
      const next = nextPacificTimestamp(data, year, previousAt, modifiedAt)
      const { at } = next
      year = next.year
      previousAt = at
      lastHeader = {
        at,
        input: Number(data.input) || 0,
        output: Number(data.output) || 0,
        failed: data.flag === "!",
      }
    } else if (lastHeader && line.startsWith("session: ")) {
      const raw = line.slice("session: ".length).trim().replace(TRIM_QUOTES, "")
      const id = raw.split("/")[0]?.trim()
      if (id) lastAgent = id
    }
  }
  commit()

  return {
    source: "audit-log",
    dateBasis: "America/Los_Angeles",
    partial: false,
    total,
    days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    agents: [...byAgent.values()].sort((a, b) => b.calls - a.calls),
    ...(firstRecordedAt !== undefined ? { firstRecordedAt } : {}),
    ...(lastRecordedAt !== undefined ? { lastRecordedAt } : {}),
  }
}

export async function readAuditUsage(path: string): Promise<UsageAnalytics> {
  const fileStat = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  if (!fileStat) return parseAuditUsage("", Date.now())
  // Keep historical computation bounded; if the file grows, indicate partial
  // coverage rather than silently presenting it as a complete history.
  if (fileStat.size > MAX_AUDIT_BYTES) {
    const { open } = await import("node:fs/promises")
    const handle = await open(path, "r")
    try {
      const buffer = Buffer.alloc(MAX_AUDIT_BYTES)
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        fileStat.size - MAX_AUDIT_BYTES
      )
      const text = buffer.toString("utf8", 0, bytesRead)
      const firstHeading = text.indexOf("\n--- # ")
      const summary = parseAuditUsage(
        firstHeading >= 0 ? text.slice(firstHeading + 1) : "",
        fileStat.mtimeMs
      )
      return { ...summary, partial: true }
    } finally {
      await handle.close()
    }
  }
  return parseAuditUsage(await readFile(path, "utf8"), fileStat.mtimeMs)
}
