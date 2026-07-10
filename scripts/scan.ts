// Stage 3: parse raw Gmail results into the ledger. Deterministic only;
// if an amount cannot be extracted, the row stays unverified with a null.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUSD } from "../src/money.ts";
import { buildLedger, merchantKey, parseEmails, type RawEmail } from "../src/parse.ts";
import type { Subscription } from "../src/types.ts";
import { ping } from "./ping.ts";

const OUT = process.env.KILL_LIST_OUT ?? join(import.meta.dir, "..", "out");

export interface LedgerFile {
  meta: {
    scan_date: string;
    emails_seen: number;
    events_kept: number;
    mode: "kill" | "prospect" | null;
  };
  subscriptions: Subscription[];
}

interface RawMessage {
  id?: unknown;
  sender?: unknown;
  from?: unknown;
  subject?: unknown;
  date?: unknown;
  internalDate?: unknown;
  body?: unknown;
  plaintextBody?: unknown;
  messages?: unknown;
}

function toIso(date: string): string {
  if (/^\d{10,13}$/.test(date)) {
    const n = Number(date);
    return new Date(date.length === 13 ? n : n * 1000).toISOString();
  }
  return date;
}

// Accepts whatever shape the Gmail tools saved: a message, an array of
// messages, or a { messages: [...] } wrapper. Anything unreadable is dropped.
export function normalizeRaw(json: unknown): RawEmail[] {
  if (Array.isArray(json)) return json.flatMap(normalizeRaw);
  if (typeof json !== "object" || json === null) return [];
  const m = json as RawMessage;
  if (Array.isArray(m.messages)) return m.messages.flatMap(normalizeRaw);
  const id = m.id;
  const sender = m.sender ?? m.from;
  const subject = m.subject;
  const date = m.date ?? m.internalDate;
  if (
    typeof id !== "string" ||
    typeof sender !== "string" ||
    typeof subject !== "string" ||
    typeof date !== "string"
  ) {
    return [];
  }
  const body = m.body ?? m.plaintextBody;
  return [{ id, sender, subject, date: toIso(date), body: typeof body === "string" ? body : undefined }];
}

// A re-scan must never clobber what the user did in the cockpit.
export function mergeUserEdits(fresh: Subscription[], prior: Subscription[]): Subscription[] {
  const byKey = new Map(prior.map((p) => [merchantKey(p.merchant), p]));
  return fresh.map((sub) => {
    const old = byKey.get(merchantKey(sub.merchant));
    if (!old) return sub;
    const merged: Subscription = {
      ...sub,
      user_state: old.user_state,
      category: old.category || sub.category,
      included_in_receipt: old.included_in_receipt,
      verdict_overruled: old.verdict_overruled,
    };
    if (old.verdict_overruled) {
      merged.verdict = old.verdict;
      merged.verdict_reason = old.verdict_reason;
    }
    return merged;
  });
}

if (import.meta.main) {
  await ping("parsing");

  const rawDir = join(OUT, "raw");
  if (!existsSync(rawDir)) {
    console.error(`nothing to parse: save Gmail query results as JSON in ${rawDir} first (stage 2)`);
    process.exit(1);
  }

  const emails: RawEmail[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(rawDir).filter((f) => f.endsWith(".json")).sort()) {
    for (const email of normalizeRaw(JSON.parse(readFileSync(join(rawDir, file), "utf8")))) {
      if (seen.has(email.id)) continue;
      seen.add(email.id);
      emails.push(email);
    }
  }

  const now = new Date().toISOString();
  const events = parseEmails(emails);
  const fresh = buildLedger(events, now);

  const ledgerPath = join(OUT, "ledger.json");
  let subscriptions = fresh;
  if (existsSync(ledgerPath)) {
    const prior = JSON.parse(readFileSync(ledgerPath, "utf8")) as LedgerFile;
    subscriptions = mergeUserEdits(fresh, prior.subscriptions ?? []);
  }

  const ledger: LedgerFile = {
    meta: {
      scan_date: now.slice(0, 10),
      emails_seen: emails.length,
      events_kept: events.length,
      mode: null,
    },
    subscriptions,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");

  console.log(`${emails.length} emails in, ${events.length} charge events, ${subscriptions.length} merchants\n`);
  for (const s of subscriptions) {
    const price =
      s.monthly_equivalent !== null
        ? `${formatUSD(Math.round(s.monthly_equivalent * 100))}/mo`
        : s.amount !== null
          ? `${formatUSD(Math.round(s.amount * 100))} ${s.cadence}`
          : "unverified";
    console.log(`  ${s.merchant.padEnd(30)} ${price.padStart(12)}  ${s.status.padEnd(9)} ${s.confidence}`);
  }
  console.log(`\nwrote ${ledgerPath}`);
}
