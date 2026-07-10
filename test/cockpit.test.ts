import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subscription } from "../src/types.ts";

const OUT = mkdtempSync(join(tmpdir(), "kill-cockpit-"));
process.env.KILL_LIST_ENGINE = join(import.meta.dir, "..");
process.env.KILL_LIST_OUT = OUT;

const handler = (await import("../cockpit/api.ts")).default;

const TOKEN = "test-token-0123456789abcdef";

function sub(over: Partial<Subscription>): Subscription {
  return {
    merchant: "Testco",
    amount: 10,
    currency: "USD",
    cadence: "monthly",
    monthly_equivalent: 10,
    first_seen: "2025-06-01T00:00:00Z",
    last_charge: "2026-07-01T00:00:00Z",
    charge_count: 5,
    status: "active",
    confidence: "high",
    source_msg_ids: ["m1"],
    category: "",
    user_state: "pending",
    verdict: null,
    verdict_reason: null,
    verdict_overruled: false,
    included_in_receipt: false,
    ...over,
  };
}

function seed(subs: Subscription[]): void {
  writeFileSync(join(OUT, "cockpit-token"), TOKEN + "\n");
  writeFileSync(
    join(OUT, "ledger.json"),
    JSON.stringify(
      { meta: { scan_date: "2026-07-10", emails_seen: 1, events_kept: 1, mode: null }, subscriptions: subs },
      null,
      2,
    ),
  );
}

function ledgerOnDisk(): { subscriptions: Subscription[] } {
  return JSON.parse(readFileSync(join(OUT, "ledger.json"), "utf8"));
}

interface Captured {
  json: unknown;
  status: number;
  headers?: Record<string, string>;
}

async function call(opts: {
  method: "GET" | "POST";
  query?: Record<string, string>;
  body?: unknown;
}): Promise<Captured> {
  const captured: Captured = { json: undefined, status: 200 };
  const c = {
    req: {
      method: opts.method,
      query: (k: string) => opts.query?.[k],
      json: async () => opts.body,
    },
    json: (data: unknown, code?: number) => {
      captured.json = data;
      captured.status = code ?? 200;
      return captured;
    },
    body: (data: unknown, code: number, headers: Record<string, string>) => {
      captured.json = data;
      captured.status = code;
      captured.headers = headers;
      return captured;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handler(c as any);
  return captured;
}

beforeEach(() => {
  mkdirSync(OUT, { recursive: true });
  seed([sub({ merchant: "Alpha" }), sub({ merchant: "Beta", monthly_equivalent: null, amount: null })]);
});

describe("token gate", () => {
  test("GET without token is refused", async () => {
    const r = await call({ method: "GET", query: { a: "state" } });
    expect(r.status).toBe(401);
  });

  test("GET with the wrong token is refused", async () => {
    const r = await call({ method: "GET", query: { t: "wrong", a: "state" } });
    expect(r.status).toBe(401);
  });

  test("POST with the wrong token is refused before any action runs", async () => {
    const r = await call({ method: "POST", body: { t: "wrong", a: "row", key: "alpha", patch: { user_state: "confirmed" } } });
    expect(r.status).toBe(401);
    expect(ledgerOnDisk().subscriptions[0].user_state).toBe("pending");
  });
});

describe("state", () => {
  test("returns the ledger with row keys", async () => {
    const r = await call({ method: "GET", query: { t: TOKEN, a: "state" } });
    expect(r.status).toBe(200);
    const j = r.json as { ledger: { subscriptions: (Subscription & { _key: string })[] } };
    expect(j.ledger.subscriptions.map((s) => s._key)).toEqual(["alpha", "beta"]);
  });
});

describe("png serving", () => {
  test("rejects anything but the whitelisted receipt names", async () => {
    for (const f of ["../ledger.json", "wall.json", "receipt-1080x1350.png.txt", ""]) {
      const r = await call({ method: "GET", query: { t: TOKEN, a: "png", f } });
      expect(r.status).toBe(400);
    }
  });

  test("404s when nothing is rendered yet", async () => {
    const r = await call({ method: "GET", query: { t: TOKEN, a: "png", f: "receipt-1080x1350.png" } });
    expect(r.status).toBe(404);
  });
});

describe("row patches", () => {
  test("valid user_state change persists to disk", async () => {
    const r = await call({
      method: "POST",
      body: { t: TOKEN, a: "row", key: "alpha", patch: { user_state: "confirmed", included_in_receipt: true } },
    });
    expect(r.status).toBe(200);
    const row = ledgerOnDisk().subscriptions[0];
    expect(row.user_state).toBe("confirmed");
    expect(row.included_in_receipt).toBe(true);
  });

  test("bad user_state is rejected", async () => {
    const r = await call({ method: "POST", body: { t: TOKEN, a: "row", key: "alpha", patch: { user_state: "hidden" } } });
    expect(r.status).toBe(400);
  });

  test("unknown key 404s", async () => {
    const r = await call({ method: "POST", body: { t: TOKEN, a: "row", key: "ghost", patch: { user_state: "confirmed" } } });
    expect(r.status).toBe(404);
  });

  test("overrule stamps verdict with reason; clearing resets the flag", async () => {
    const r = await call({
      method: "POST",
      body: { t: TOKEN, a: "row", key: "alpha", patch: { overrule: { verdict: "KEEP", reason: "I like it" } } },
    });
    expect(r.status).toBe(200);
    let row = ledgerOnDisk().subscriptions[0];
    expect(row.verdict).toBe("KEEP");
    expect(row.verdict_overruled).toBe(true);

    await call({ method: "POST", body: { t: TOKEN, a: "row", key: "alpha", patch: { overrule: null } } });
    row = ledgerOnDisk().subscriptions[0];
    expect(row.verdict_overruled).toBe(false);
  });

  test("overrule without a reason is rejected", async () => {
    const r = await call({
      method: "POST",
      body: { t: TOKEN, a: "row", key: "alpha", patch: { overrule: { verdict: "KILL", reason: "" } } },
    });
    expect(r.status).toBe(400);
  });
});

describe("manual add", () => {
  test("parses the amount through string-to-cents, never floats", async () => {
    const r = await call({ method: "POST", body: { t: TOKEN, a: "add", merchant: "Gym", amount: "$12.50", cadence: "annual" } });
    expect(r.status).toBe(200);
    const row = ledgerOnDisk().subscriptions.find((s) => s.merchant === "Gym");
    expect(row?.amount).toBe(12.5);
    expect(row?.monthly_equivalent).toBe(1.04);
    expect(row?.user_state).toBe("confirmed");
  });

  test("unparseable amounts stay null and unverified", async () => {
    const r = await call({ method: "POST", body: { t: TOKEN, a: "add", merchant: "Vague", amount: "about ten bucks" } });
    expect(r.status).toBe(200);
    const row = ledgerOnDisk().subscriptions.find((s) => s.merchant === "Vague");
    expect(row?.amount).toBeNull();
    expect(row?.monthly_equivalent).toBeNull();
  });

  test("duplicate merchants are refused", async () => {
    const r = await call({ method: "POST", body: { t: TOKEN, a: "add", merchant: "ALPHA", amount: "$5" } });
    expect(r.status).toBe(409);
  });
});

describe("wall push", () => {
  test("refuses without a rendered receipt", async () => {
    const r = await call({ method: "POST", body: { t: TOKEN, a: "wall" } });
    expect(r.status).toBe(409);
  });

  test("refuses without a session even when a receipt exists", async () => {
    mkdirSync(join(OUT, "receipt"), { recursive: true });
    writeFileSync(join(OUT, "receipt", "wall.json"), JSON.stringify({ id: "KL-1" }));
    const r = await call({ method: "POST", body: { t: TOKEN, a: "wall" } });
    expect(r.status).toBe(409);
    expect(String((r.json as { error: string }).error)).toContain("session");
  });
});
