import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleCatalog } from "../scripts/build-catalog.ts";
import { mergeUserEdits, normalizeRaw } from "../scripts/scan.ts";
import { stampLedger, type Judgments } from "../scripts/verdict.ts";
import type { CatalogEntry, Subscription } from "../src/types.ts";

describe("normalizeRaw", () => {
  const full = {
    id: "m1",
    sender: "Acme <receipts@acme.test>",
    subject: "Your receipt from Acme #1",
    date: "2026-06-01T00:00:00Z",
    body: "Amount paid $8.00",
  };

  test("accepts a bare array of messages", () => {
    const out = normalizeRaw([full]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("m1");
    expect(out[0].body).toContain("$8.00");
  });

  test("accepts a { messages } wrapper with from/plaintextBody field names", () => {
    const out = normalizeRaw({
      messages: [{ id: "m2", from: "x@y.test", subject: "s", date: "2026-06-01", plaintextBody: "b" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].sender).toBe("x@y.test");
    expect(out[0].body).toBe("b");
  });

  test("converts epoch-millis internalDate to ISO", () => {
    const out = normalizeRaw({ id: "m3", from: "x@y.test", subject: "s", internalDate: "1750000000000" });
    expect(out[0].date).toBe("2025-06-15T15:06:40.000Z");
  });

  test("drops entries missing required fields and non-objects", () => {
    expect(normalizeRaw([{ subject: "no id" }, null, 42, "text"])).toHaveLength(0);
  });
});

function sub(over: Partial<Subscription>): Subscription {
  return {
    merchant: "Acme AI",
    amount: 8,
    currency: "USD",
    cadence: "monthly",
    monthly_equivalent: 8,
    first_seen: "2026-01-01",
    last_charge: "2026-06-01",
    charge_count: 5,
    status: "active",
    confidence: "high",
    source_msg_ids: [],
    category: "",
    user_state: "pending",
    verdict: null,
    verdict_reason: null,
    verdict_overruled: false,
    included_in_receipt: false,
    ...over,
  };
}

describe("mergeUserEdits", () => {
  test("re-scan keeps cockpit state, including overruled verdicts", () => {
    const prior = [
      sub({
        merchant: "Acme AI Inc.",
        user_state: "confirmed",
        category: "ai-assistant",
        verdict: "KEEP",
        verdict_reason: "KEEP: user said so",
        verdict_overruled: true,
        included_in_receipt: true,
      }),
    ];
    const fresh = [sub({ merchant: "Acme AI", charge_count: 6 }), sub({ merchant: "Newco" })];
    const merged = mergeUserEdits(fresh, prior);

    expect(merged[0].charge_count).toBe(6);
    expect(merged[0].user_state).toBe("confirmed");
    expect(merged[0].category).toBe("ai-assistant");
    expect(merged[0].verdict).toBe("KEEP");
    expect(merged[0].verdict_overruled).toBe(true);
    expect(merged[0].included_in_receipt).toBe(true);
    expect(merged[1].user_state).toBe("pending");
  });

  test("non-overruled verdicts are not carried over; verdict.ts restamps them", () => {
    const prior = [sub({ user_state: "confirmed", verdict: "KILL", verdict_reason: "KILL: old" })];
    const merged = mergeUserEdits([sub({})], prior);
    expect(merged[0].user_state).toBe("confirmed");
    expect(merged[0].verdict).toBeNull();
  });
});

const acmeEntry: CatalogEntry = {
  slug: "acme-ai",
  name: "Acme AI",
  category: "ai-assistant",
  typical_price_monthly: 8,
  price_basis: "advertised plan, checked 2026-07",
  verdict: "KILL",
  verdict_reason: "KILL: it is a wrapper",
  what_zo_builds: "...",
  hours_to_build: 1,
  annual_savings: 96,
  dont_kill_if: "...",
  build_brief: "...",
  sources: ["https://example.com"],
};

describe("stampLedger", () => {
  test("catalog hit stamps verdict and fills empty category", () => {
    const rows = [sub({ user_state: "confirmed" })];
    const { needs_judgment } = stampLedger(rows, [acmeEntry], {});
    expect(rows[0].verdict).toBe("KILL");
    expect(rows[0].verdict_reason).toBe("KILL: it is a wrapper");
    expect(rows[0].category).toBe("ai-assistant");
    expect(needs_judgment).toHaveLength(0);
  });

  test("overruled and excluded rows are never touched", () => {
    const rows = [
      sub({ user_state: "confirmed", verdict: "KEEP", verdict_reason: "KEEP: mine", verdict_overruled: true }),
      sub({ user_state: "excluded" }),
    ];
    const { needs_judgment } = stampLedger(rows, [acmeEntry], {});
    expect(rows[0].verdict).toBe("KEEP");
    expect(rows[1].verdict).toBeNull();
    expect(needs_judgment).toHaveLength(0);
  });

  test("no catalog hit: judgment file feeds the rubric with ledger price", () => {
    const judgments: Judgments = { "unknown tool": { walls: {}, hours_to_build: 8 } };
    const rows = [sub({ merchant: "Unknown Tool Inc.", monthly_equivalent: 15, user_state: "confirmed" })];
    stampLedger(rows, [acmeEntry], judgments);
    expect(rows[0].verdict).toBe("KILL");
    expect(rows[0].verdict_reason).toContain("$15.00");
  });

  test("a single wall in the judgment forces KEEP", () => {
    const judgments: Judgments = { deadco: { walls: { money_movement: true }, hours_to_build: 1 } };
    const rows = [sub({ merchant: "Deadco", user_state: "confirmed" })];
    stampLedger(rows, [], judgments);
    expect(rows[0].verdict).toBe("KEEP");
  });

  test("no catalog, no judgment: row is reported, not guessed", () => {
    const rows = [sub({ merchant: "Mystery Corp", user_state: "confirmed" })];
    const { needs_judgment } = stampLedger(rows, [], {});
    expect(rows[0].verdict).toBeNull();
    expect(needs_judgment).toEqual(["Mystery Corp"]);
  });
});

describe("bundleCatalog", () => {
  function entryFile(dir: string, slug: string, over: Record<string, unknown> = {}) {
    writeFileSync(join(dir, `${slug}.json`), JSON.stringify({ ...acmeEntry, slug, ...over }));
  }

  test("bundles clean entries sorted by filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "kl-cat-"));
    entryFile(dir, "zeta");
    entryFile(dir, "alpha");
    const { entries, problems } = bundleCatalog(dir);
    expect(problems).toEqual([]);
    expect(entries.map((e) => e.slug)).toEqual(["alpha", "zeta"]);
  });

  test("reports missing fields, slug mismatch, and bad verdicts instead of writing garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "kl-cat-"));
    entryFile(dir, "broken", { price_basis: "", verdict: "MAYBE" });
    writeFileSync(join(dir, "renamed.json"), JSON.stringify({ ...acmeEntry, slug: "other" }));
    const { problems } = bundleCatalog(dir);
    expect(problems).toContain("broken.json: missing price_basis");
    expect(problems).toContain('broken.json: bad verdict "MAYBE"');
    expect(problems).toContain('renamed.json: slug "other" does not match filename');
  });
});

describe("stampLedger bespoke reasons", () => {
  test("judgment reason prints with the stamped verdict", () => {
    const judgments: Judgments = {
      "unknown tool": { walls: {}, hours_to_build: 8, reason: "one route on your Zo; {mo} is rent" },
    };
    const rows = [sub({ merchant: "Unknown Tool Inc.", monthly_equivalent: 15, user_state: "confirmed" })];
    stampLedger(rows, [acmeEntry], judgments);
    expect(rows[0].verdict).toBe("KILL");
    expect(rows[0].verdict_reason).toBe("KILL: one route on your Zo; $15.00/mo is rent");
  });

  test("hand-typed dollar amount falls back to the stock template", () => {
    const judgments: Judgments = {
      "unknown tool": { walls: {}, hours_to_build: 8, reason: "you pay $180 a year for grep" },
    };
    const rows = [sub({ merchant: "Unknown Tool Inc.", monthly_equivalent: 15, user_state: "confirmed" })];
    stampLedger(rows, [acmeEntry], judgments);
    expect(rows[0].verdict).toBe("KILL");
    expect(rows[0].verdict_reason).toBe("KILL: under a day of build replaces $15.00/mo");
  });

  test("catalog hits ignore judgment reasons; the catalog line wins", () => {
    const judgments: Judgments = {
      "acme ai": { walls: {}, hours_to_build: 8, reason: "should never print" },
    };
    const rows = [sub({ merchant: "Acme AI", user_state: "confirmed" })];
    stampLedger(rows, [acmeEntry], judgments);
    expect(rows[0].verdict_reason).toBe("KILL: it is a wrapper");
  });
});
