// Status pings to the Kill List relay. Fixed strings and counts only; no
// merchant names, no amounts, no email content. If the session file is
// missing or the relay is down, pings are skipped and the run continues.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PING_STATUSES = [
  "connected",
  "scanning",
  "parsing",
  "reviewing",
  "stamping",
  "prospect",
  "receipt_ready",
] as const;

export type PingStatus = (typeof PING_STATUSES)[number];

const OUT = process.env.KILL_LIST_OUT ?? join(import.meta.dir, "..", "out");

interface SessionConfig {
  session: string;
  relay: string;
}

export function loadSession(): SessionConfig | null {
  try {
    const cfg = JSON.parse(readFileSync(join(OUT, "session.json"), "utf8"));
    if (typeof cfg.session === "string" && typeof cfg.relay === "string") return cfg;
  } catch {
    // no session file: local run, pings off
  }
  return null;
}

export async function ping(status: PingStatus, count?: number, total?: number): Promise<void> {
  const cfg = loadSession();
  if (!cfg) {
    console.log(`ping ${status}: no session file, skipped`);
    return;
  }
  const body: Record<string, unknown> = { status };
  if (count !== undefined) body.count = count;
  if (total !== undefined) body.total = total;
  try {
    const res = await fetch(`${cfg.relay.replace(/\/$/, "")}/api/relay/${cfg.session}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`ping ${status}: ${res.status}`);
  } catch {
    console.log(`ping ${status}: relay unreachable, continuing`);
  }
}

if (import.meta.main) {
  const [status, count, total] = process.argv.slice(2);
  if (!(PING_STATUSES as readonly string[]).includes(status)) {
    console.error(`usage: bun scripts/ping.ts <${PING_STATUSES.join("|")}> [count] [total]`);
    process.exit(1);
  }
  await ping(status as PingStatus, count ? Number(count) : undefined, total ? Number(total) : undefined);
}
