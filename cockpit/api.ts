// Kill List cockpit API. Deployed onto the user's own Zo as a space route
// (SKILL.md stage 4). Space API routes are always public, so every request
// must carry the capability token minted by scripts/cockpit.ts. Everything
// this route touches stays on this machine; the only outbound call is the
// explicit Print-to-the-Wall push, and that sends sanitized JSON only.
import type { Context } from "hono";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// Where the paste command cloned the engine. Adjust if it lives elsewhere.
const ENGINE = process.env.KILL_LIST_ENGINE ?? "/home/workspace/kill-list";
const OUT = process.env.KILL_LIST_OUT ?? join(ENGINE, "out");

const runFile = promisify(execFile);

const USER_STATES = ["pending", "confirmed", "excluded", "private"] as const;
const VERDICTS = ["KILL", "KEEP", "TRIM"] as const;
const PNG_NAME = /^receipt(-sanitized)?-\d{3,4}x\d{3,4}\.png$/;

function tokenOk(given: unknown): boolean {
  const path = join(OUT, "cockpit-token");
  if (typeof given !== "string" || given.length === 0 || !existsSync(path)) return false;
  const want = Buffer.from(readFileSync(path, "utf8").trim());
  const got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got);
}

function readJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

interface LedgerLike {
  meta: Record<string, unknown>;
  subscriptions: Record<string, unknown>[];
}

function loadLedger(): LedgerLike | null {
  const path = join(OUT, "ledger.json");
  if (!existsSync(path)) return null;
  return readJSON(path) as LedgerLike;
}

function saveLedger(ledger: LedgerLike): void {
  writeFileSync(join(OUT, "ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
}

async function engine(): Promise<{
  merchantKey: (m: string) => string;
  tokenToCents: (t: string) => number | null;
  monthlyEquivalent: (cents: number, cadence: string) => number | null;
  CADENCES: readonly string[];
}> {
  try {
    const parse = await import(join(ENGINE, "src", "parse.ts"));
    const money = await import(join(ENGINE, "src", "money.ts"));
    return {
      merchantKey: parse.merchantKey,
      tokenToCents: money.tokenToCents,
      monthlyEquivalent: money.monthlyEquivalent,
      CADENCES: ["monthly", "annual", "quarterly", "weekly", "unknown"],
    };
  } catch {
    throw new Error(`engine not found at ${ENGINE}: fix the ENGINE const in this route`);
  }
}

async function state(): Promise<Record<string, unknown>> {
  const { merchantKey } = await engine();
  const ledger = loadLedger();
  if (ledger) {
    ledger.subscriptions = ledger.subscriptions.map((s) => ({ ...s, _key: merchantKey(String(s.merchant)) }));
  }
  const wallPath = join(OUT, "receipt", "wall.json");
  return {
    ledger,
    wall: existsSync(wallPath) ? readJSON(wallPath) : null,
    has_session: existsSync(join(OUT, "session.json")),
    has_receipt: existsSync(join(OUT, "receipt", "receipt-1080x1350.png")),
  };
}

async function loadCatalog(): Promise<unknown[]> {
  const single = join(ENGINE, "catalog.json");
  if (!existsSync(single)) return [];
  const parsed = readJSON(single);
  if (!Array.isArray(parsed)) return [];
  const { merchantKey } = await engine();
  return parsed.map((e: Record<string, unknown>) => ({
    ...e,
    _keys: [
      merchantKey(String(e.name ?? "")),
      merchantKey(String(e.slug ?? "").replace(/-/g, " ")),
      ...(Array.isArray(e.aliases) ? e.aliases.map((a) => merchantKey(String(a))) : []),
    ],
  }));
}

async function patchRow(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { merchantKey } = await engine();
  const ledger = loadLedger();
  if (!ledger) return { error: "no ledger yet: run the scan stages first", code: 409 };
  const key = body.key;
  if (typeof key !== "string") return { error: "missing row key", code: 400 };
  const sub = ledger.subscriptions.find((s) => merchantKey(String(s.merchant)) === key);
  if (!sub) return { error: `no row for key ${key}`, code: 404 };
  const patch = (body.patch ?? {}) as Record<string, unknown>;

  if (patch.user_state !== undefined) {
    if (!USER_STATES.includes(patch.user_state as (typeof USER_STATES)[number])) {
      return { error: "bad user_state", code: 400 };
    }
    sub.user_state = patch.user_state;
  }
  if (patch.included_in_receipt !== undefined) {
    if (typeof patch.included_in_receipt !== "boolean") return { error: "bad included_in_receipt", code: 400 };
    sub.included_in_receipt = patch.included_in_receipt;
  }
  if (patch.category !== undefined) {
    if (typeof patch.category !== "string" || patch.category.length > 40) {
      return { error: "bad category", code: 400 };
    }
    sub.category = patch.category;
  }
  if (patch.overrule !== undefined) {
    if (patch.overrule === null) {
      // Cleared overrules get restamped by the rubric on the next rebuild.
      sub.verdict_overruled = false;
    } else {
      const o = patch.overrule as Record<string, unknown>;
      if (!VERDICTS.includes(o.verdict as (typeof VERDICTS)[number])) return { error: "bad verdict", code: 400 };
      if (typeof o.reason !== "string" || o.reason.length === 0 || o.reason.length > 140) {
        return { error: "overrule needs a reason under 140 chars", code: 400 };
      }
      sub.verdict = o.verdict;
      sub.verdict_reason = o.reason;
      sub.verdict_overruled = true;
    }
  }
  saveLedger(ledger);
  return { ok: true, ...(await state()) };
}

async function addRow(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { merchantKey, tokenToCents, monthlyEquivalent, CADENCES } = await engine();
  const ledger = loadLedger();
  if (!ledger) return { error: "no ledger yet: run the scan stages first", code: 409 };
  const merchant = typeof body.merchant === "string" ? body.merchant.trim().slice(0, 60) : "";
  const cadence = typeof body.cadence === "string" && CADENCES.includes(body.cadence) ? body.cadence : "monthly";
  if (!merchant) return { error: "merchant name required", code: 400 };
  if (ledger.subscriptions.some((s) => merchantKey(String(s.merchant)) === merchantKey(merchant))) {
    return { error: "that merchant is already in the ledger", code: 409 };
  }
  // User-entered amount, parsed by the same string-to-cents path as email
  // amounts. Unparseable input stays null and unverified, never guessed.
  const cents = typeof body.amount === "string" ? tokenToCents(body.amount) : null;
  const monthlyCents = cents !== null ? monthlyEquivalent(cents, cadence) : null;
  const today = new Date().toISOString();
  ledger.subscriptions.push({
    merchant,
    amount: cents !== null ? cents / 100 : null,
    currency: "USD",
    cadence,
    monthly_equivalent: monthlyCents !== null ? monthlyCents / 100 : null,
    first_seen: today,
    last_charge: today,
    charge_count: 0,
    status: "active",
    confidence: "high",
    source_msg_ids: [],
    category: "",
    user_state: "confirmed",
    verdict: null,
    verdict_reason: null,
    verdict_overruled: false,
    included_in_receipt: true,
    manual: true,
  });
  saveLedger(ledger);
  return { ok: true, ...(await state()) };
}

async function rebuild(): Promise<Record<string, unknown>> {
  const opts = { cwd: ENGINE, timeout: 120_000, env: { ...process.env, KILL_LIST_OUT: OUT } };
  const log: string[] = [];
  try {
    const v = await runFile("bun", ["scripts/verdict.ts"], opts);
    log.push(v.stdout.trim());
    const r = await runFile("bun", ["scripts/receipt.ts"], opts);
    log.push(r.stdout.trim());
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    log.push((e.stdout ?? "").trim(), (e.stderr ?? e.message ?? "rebuild failed").trim());
    return { error: "rebuild failed", log: log.filter(Boolean).join("\n"), code: 500 };
  }
  return { ok: true, log: log.filter(Boolean).join("\n"), ...(await state()) };
}

async function pushToWall(): Promise<Record<string, unknown>> {
  const wallPath = join(OUT, "receipt", "wall.json");
  if (!existsSync(wallPath)) return { error: "no receipt yet: rebuild first", code: 409 };
  const sessionPath = join(OUT, "session.json");
  if (!existsSync(sessionPath)) {
    return { error: "no session.json: Wall pushes only work during a connected run", code: 409 };
  }
  const session = readJSON(sessionPath) as { session?: string; relay?: string };
  if (typeof session.session !== "string" || typeof session.relay !== "string") {
    return { error: "session.json is malformed", code: 409 };
  }
  try {
    const res = await fetch(`${session.relay.replace(/\/$/, "")}/api/wall/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: session.session, receipt: readJSON(wallPath) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return { error: `relay said ${res.status}: ${text.slice(0, 200)}`, code: 502 };
    return { ok: true, relay_status: res.status };
  } catch {
    return { error: "relay unreachable", code: 502 };
  }
}

export default async (c: Context) => {
  if (c.req.method === "GET") {
    if (!tokenOk(c.req.query("t"))) return c.json({ error: "bad or missing token" }, 401);
    const action = c.req.query("a") ?? "state";
    if (action === "state") return c.json(await state());
    if (action === "catalog") return c.json({ catalog: await loadCatalog() });
    if (action === "png") {
      const name = c.req.query("f") ?? "";
      if (!PNG_NAME.test(name)) return c.json({ error: "bad file name" }, 400);
      const path = join(OUT, "receipt", name);
      if (!existsSync(path)) return c.json({ error: "not rendered yet" }, 404);
      return c.body(new Uint8Array(readFileSync(path)), 200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
    }
    return c.json({ error: "unknown action" }, 400);
  }

  if (c.req.method !== "POST") return c.json({ error: "method not allowed" }, 405);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  if (!tokenOk(body.t)) return c.json({ error: "bad or missing token" }, 401);

  try {
    const result =
      body.a === "row" ? await patchRow(body)
      : body.a === "add" ? await addRow(body)
      : body.a === "rebuild" ? await rebuild()
      : body.a === "wall" ? await pushToWall()
      : { error: "unknown action", code: 400 };
    const { code, ...rest } = result;
    return c.json(rest, (code as 200 | 400 | 404 | 409 | 500 | 502 | undefined) ?? 200);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
};
