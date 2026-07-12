import { formatUSD } from "./money.ts";
import { merchantKey } from "./parse.ts";
import type { CatalogEntry, KeepWalls, Subscription, Verdict, VerdictResult } from "./types.ts";

export const THIN_INBOX_THRESHOLD = 4;

export function isThinInbox(subs: Subscription[]): boolean {
  return subs.filter((s) => s.user_state === "confirmed").length < THIN_INBOX_THRESHOLD;
}

const WALL_REASONS: Record<keyof KeepWalls, string> = {
  money_movement: "KEEP: money moves through it; a bug costs real dollars",
  network_effects: "KEEP: other people live in this tool with you",
  hardware_coupling: "KEEP: it is welded to hardware you own",
  high_failure_cost: "KEEP: a rebuild bug loses money, data, or standing",
};

const KILL_COST_FLOOR = 1000; // 4-12h builds: KILL only above $10/mo
const TRIM_COST_FLOOR = 2000; // >12h builds: TRIM above $20/mo, else KEEP

// The deterministic half of a rubric verdict. Wall flags and build-hours are
// judgment calls supplied by the user's Zo; everything from there is math.
export function rubricVerdict(
  walls: KeepWalls,
  hoursToBuild: number,
  monthlyCents: number | null,
): VerdictResult {
  for (const wall of Object.keys(WALL_REASONS) as (keyof KeepWalls)[]) {
    if (walls[wall]) return { verdict: "KEEP", reason: WALL_REASONS[wall], source: "rubric" };
  }

  const cost = monthlyCents === null ? null : formatUSD(monthlyCents);

  if (hoursToBuild < 4) {
    return {
      verdict: "KILL",
      reason: `KILL: a ${Math.max(1, Math.round(hoursToBuild))}-hour build replaces it`,
      source: "rubric",
    };
  }

  if (hoursToBuild <= 12) {
    if (monthlyCents !== null && monthlyCents > KILL_COST_FLOOR) {
      return { verdict: "KILL", reason: `KILL: under a day of build replaces ${cost}/mo`, source: "rubric" };
    }
    return {
      verdict: "TRIM",
      reason: cost
        ? `TRIM: not worth a full kill at ${cost}/mo; downgrade instead`
        : "TRIM: price unverified; downgrade until it proves itself",
      source: "rubric",
    };
  }

  if (monthlyCents !== null && monthlyCents > TRIM_COST_FLOOR) {
    return { verdict: "TRIM", reason: `TRIM: full rebuild is heavy; kill the tier, keep the core`, source: "rubric" };
  }
  return { verdict: "KEEP", reason: "KEEP: the rebuild costs more than it saves", source: "rubric" };
}

export const BESPOKE_MAX_LENGTH = 120;

const MODEL_WRITTEN_NUMBER = /(?:\$\s*\d|\b\d+(?:[.,]\d+)?\s*(?:dollars?|bucks?|usd|hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|\/\s*(?:mo|month|yr|year))\b)/i;

// A bespoke reason line written by the user's Zo for a non-catalog merchant.
// The verdict word is stamped here, never by the model, so the line cannot
// disagree with the rubric. Number tokens {mo} {yr} {hrs} are interpolated
// from script-derived figures; a hand-typed dollar amount rejects the whole
// line and the stock template prints instead. Fail closed, always.
export function bespokeReason(
  raw: string | undefined,
  verdict: Verdict,
  monthlyCents: number | null,
  hoursToBuild: number,
): string | null {
  if (!raw) return null;
  const line = raw.trim();
  if (!line || /[\r\n]/.test(line)) return null;
  if (MODEL_WRITTEN_NUMBER.test(line)) return null;
  if (monthlyCents === null && /\{(mo|yr)\}/.test(line)) return null;
  const filled = line
    .replaceAll("{mo}", monthlyCents === null ? "" : `${formatUSD(monthlyCents)}/mo`)
    .replaceAll("{yr}", monthlyCents === null ? "" : `${formatUSD(monthlyCents * 12)}/yr`)
    .replaceAll("{hrs}", String(Math.max(1, Math.round(hoursToBuild))));
  const cleaned = filled.replace(/^(KILL|KEEP|TRIM)\s*:\s*/i, "");
  const stamped = `${verdict}: ${cleaned}`;
  return stamped.length <= BESPOKE_MAX_LENGTH ? stamped : null;
}

export function catalogVerdict(entry: CatalogEntry): VerdictResult {
  return { verdict: entry.verdict, reason: entry.verdict_reason, source: "catalog" };
}

export function matchCatalog(merchant: string, entries: CatalogEntry[]): CatalogEntry | null {
  const key = merchantKey(merchant);
  if (!key) return null;
  for (const entry of entries) {
    const names = [entry.name, entry.slug.replace(/-/g, " "), ...(entry.aliases ?? [])];
    if (names.some((n) => merchantKey(n) === key)) return entry;
  }
  return null;
}
