// Stage 5: stamp verdicts. Catalog hits are instant; everything else is the
// rubric. Wall flags and build hours in out/judgments.json are the agent's
// judgment calls; every number downstream of them is deterministic.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatUSD } from "../src/money.ts";
import { merchantKey } from "../src/parse.ts";
import type { CatalogEntry, KeepWalls, Subscription } from "../src/types.ts";
import { bespokeReason, catalogVerdict, isThinInbox, matchCatalog, rubricVerdict } from "../src/verdict.ts";
import { ping } from "./ping.ts";
import type { LedgerFile } from "./scan.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = process.env.KILL_LIST_OUT ?? join(ROOT, "out");

export interface Judgment {
  walls?: Partial<KeepWalls>;
  hours_to_build: number;
  /** One line in the house voice, written by the user's Zo. Prose only:
   * the verdict word and every number stay script-derived. */
  reason?: string;
}

export type Judgments = Record<string, Judgment>;

const NO_WALLS: KeepWalls = {
  money_movement: false,
  network_effects: false,
  hardware_coupling: false,
  high_failure_cost: false,
};

export function loadCatalog(
  candidates: string[] = [
    process.env.KILL_LIST_CATALOG ?? "",
    join(ROOT, "catalog.json"),
    join(ROOT, "..", "catalog", "entries"),
  ],
): CatalogEntry[] {
  for (const path of candidates) {
    if (!path || !existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      return readdirSync(path)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(path, f), "utf8")));
    }
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

export function stampLedger(
  subs: Subscription[],
  entries: CatalogEntry[],
  judgments: Judgments,
): { needs_judgment: string[] } {
  const needs_judgment: string[] = [];
  for (const sub of subs) {
    if (sub.user_state === "excluded" || sub.verdict_overruled) continue;

    const entry = matchCatalog(sub.merchant, entries);
    if (entry) {
      const r = catalogVerdict(entry);
      sub.verdict = r.verdict;
      sub.verdict_reason = r.reason;
      if (!sub.category) sub.category = entry.category;
      continue;
    }

    const j = judgments[merchantKey(sub.merchant)];
    if (j && Number.isFinite(j.hours_to_build) && j.hours_to_build >= 0) {
      const cents = sub.monthly_equivalent === null ? null : Math.round(sub.monthly_equivalent * 100);
      const r = rubricVerdict({ ...NO_WALLS, ...j.walls }, j.hours_to_build, cents);
      sub.verdict = r.verdict;
      sub.verdict_reason = bespokeReason(j.reason, r.verdict, cents, j.hours_to_build) ?? r.reason;
      continue;
    }

    needs_judgment.push(sub.merchant);
  }
  return { needs_judgment };
}

if (import.meta.main) {
  const ledgerPath = join(OUT, "ledger.json");
  if (!existsSync(ledgerPath)) {
    console.error("no out/ledger.json: run bun scripts/scan.ts first");
    process.exit(1);
  }
  await ping("stamping");

  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as LedgerFile;
  const entries = loadCatalog();
  if (entries.length === 0) console.log("note: no catalog found, rubric only");

  const judgmentsPath = join(OUT, "judgments.json");
  const judgments: Judgments = existsSync(judgmentsPath)
    ? JSON.parse(readFileSync(judgmentsPath, "utf8"))
    : {};

  const { needs_judgment } = stampLedger(ledger.subscriptions, entries, judgments);
  const thin = isThinInbox(ledger.subscriptions);
  ledger.meta.mode = thin ? "prospect" : "kill";
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  if (thin) await ping("prospect");

  let killCents = 0;
  for (const s of ledger.subscriptions) {
    if (s.user_state === "excluded") continue;
    console.log(`  ${(s.verdict ?? "----").padEnd(5)} ${s.merchant.padEnd(30)} ${s.verdict_reason ?? "awaiting judgment"}`);
    if (s.verdict === "KILL" && s.monthly_equivalent !== null) {
      killCents += Math.round(s.monthly_equivalent * 100);
    }
  }
  console.log(`\nKILL total: ${formatUSD(killCents)}/mo, ${formatUSD(killCents * 12)}/yr`);
  if (thin) console.log("Thin inbox. Prospect mode: price the bill they never got.");
  if (needs_judgment.length > 0) {
    console.log(`\nNEEDS JUDGMENT (${needs_judgment.length}): add these to out/judgments.json and run this again`);
    for (const m of needs_judgment) console.log(`  - ${m}`);
  }
}
