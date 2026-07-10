import { describe, expect, test } from "bun:test";
import {
  barcodeBars,
  barcodeWidth,
  buildKillModel,
  buildProspectModel,
  fnv1a,
  receiptRows,
  receiptSVG,
  stampRotation,
  wallPayload,
} from "../src/receipt.ts";
import type { CatalogEntry, Subscription } from "../src/types.ts";

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
    category: "ai-coding",
    user_state: "confirmed",
    verdict: "KILL",
    verdict_reason: "test",
    verdict_overruled: false,
    included_in_receipt: true,
    ...over,
  };
}

const OPTS = { today: "2026-07-12", host: "example.test" };

describe("receiptRows", () => {
  test("only confirmed, included, stamped rows make the receipt", () => {
    const rows = receiptRows([
      sub({ merchant: "A" }),
      sub({ merchant: "B", user_state: "pending" }),
      sub({ merchant: "C", user_state: "private" }),
      sub({ merchant: "D", user_state: "excluded" }),
      sub({ merchant: "E", included_in_receipt: false }),
      sub({ merchant: "F", verdict: null }),
    ]);
    expect(rows.map((r) => r.merchant)).toEqual(["A"]);
  });
});

describe("buildKillModel", () => {
  test("totals are sums of included rows; hero is KILL only", () => {
    const m = buildKillModel(
      [
        sub({ merchant: "A", monthly_equivalent: 20 }),
        sub({ merchant: "B", monthly_equivalent: 5, verdict: "KEEP" }),
        sub({ merchant: "C", monthly_equivalent: 7.5, verdict: "TRIM" }),
      ],
      OPTS,
    );
    expect(m.bill_cents).toBe(3250);
    expect(m.hero_cents).toBe(2000);
    expect(m.counts).toEqual({ KILL: 1, KEEP: 1, TRIM: 1, SKIP: 0 });
  });

  test("null amounts render unverified and never count", () => {
    const m = buildKillModel([sub({ merchant: "A" }), sub({ merchant: "B", monthly_equivalent: null })], OPTS);
    expect(m.bill_cents).toBe(1000);
    expect(m.lines.find((l) => l.label === "B")?.monthly_cents).toBeNull();
    const svg = receiptSVG(m, { width: 1080, height: 1350 });
    expect(svg).toContain("UNVERIFIED");
  });

  test("sanitize swaps labels for categories and rounds to dollars", () => {
    const m = buildKillModel([sub({ merchant: "Secret Corp", monthly_equivalent: 19.99 })], {
      ...OPTS,
      sanitize: true,
    });
    expect(m.lines[0].label).toBe("AI CODING");
    expect(m.lines[0].monthly_cents).toBe(2000);
  });

  test("same ledger, same id; different ledger, different id", () => {
    const a = buildKillModel([sub({})], OPTS);
    const b = buildKillModel([sub({})], OPTS);
    const c = buildKillModel([sub({ monthly_equivalent: 11 })], OPTS);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    expect(a.id).toMatch(/^KL-20260712-[0-9A-F]{4}$/);
  });

  test("overflow past 16 lines aggregates into + N MORE", () => {
    const subs = Array.from({ length: 20 }, (_, i) =>
      sub({ merchant: `M${String(i).padStart(2, "0")}`, monthly_equivalent: i + 1 }),
    );
    const m = buildKillModel(subs, OPTS);
    expect(m.lines.length).toBe(16);
    expect(m.more_count).toBe(4);
    expect(m.more_cents).toBe(100 + 200 + 300 + 400);
    expect(m.bill_cents).toBe(subs.reduce((t, s) => t + (s.monthly_equivalent ?? 0) * 100, 0));
  });
});

describe("buildProspectModel", () => {
  const catalog: CatalogEntry[] = [
    {
      slug: "notion",
      name: "Notion",
      category: "notes-and-docs",
      typical_price_monthly: 12,
      price_basis: "advertised Plus plan, 2026-07",
      verdict: "KILL",
      verdict_reason: "r",
      what_zo_builds: "w",
      hours_to_build: 3,
      annual_savings: 144,
      dont_kill_if: "d",
      build_brief: "b",
      sources: ["https://notion.com/pricing"],
    },
  ];

  test("prices come from the catalog, unknown slugs drop, stamps are SKIP", () => {
    const m = buildProspectModel(["notion", "made-up"], catalog, OPTS);
    expect(m.lines.length).toBe(1);
    expect(m.lines[0]).toMatchObject({ label: "NOTION", monthly_cents: 1200, verdict: "SKIP" });
    expect(m.hero_cents).toBe(1200);
    expect(m.mode).toBe("prospect");
    const svg = receiptSVG(m, { width: 1080, height: 1350 });
    expect(svg).toContain("THE BILL YOU NEVER GOT");
    expect(svg).toContain("ZO CAN PREVENT");
  });
});

describe("determinism", () => {
  test("stamp rotation is stable and in the -4..+3 range", () => {
    for (const label of ["NOTION", "ZAPIER", "A", "OTTER.AI", "X PREMIUM"]) {
      const r = stampRotation(label);
      expect(r).toBe(stampRotation(label));
      expect(r).toBeGreaterThanOrEqual(-4);
      expect(r).toBeLessThanOrEqual(3.1);
    }
  });

  test("fnv1a is stable", () => {
    expect(fnv1a("kill-list")).toBe(fnv1a("kill-list"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });

  test("barcode encodes start/stop and only legal chars", () => {
    const bars = barcodeBars("KL-1");
    // *KL-1* = 6 chars x 5 bars
    expect(bars.length).toBe(30);
    expect(barcodeWidth("KL-1")).toBeGreaterThan(0);
    expect(barcodeBars("kl-1")).toEqual(bars);
  });

  test("same model renders byte-identical SVG", () => {
    const m = buildKillModel([sub({})], OPTS);
    const a = receiptSVG(m, { width: 1080, height: 1350 });
    expect(a).toBe(receiptSVG(m, { width: 1080, height: 1350 }));
  });
});

describe("wallPayload", () => {
  test("refuses unsanitized models", () => {
    const m = buildKillModel([sub({})], OPTS);
    expect(() => wallPayload(m)).toThrow();
  });

  test("carries exactly what the PNG shows", () => {
    const m = buildKillModel([sub({ merchant: "Secret Corp" })], { ...OPTS, sanitize: true });
    const w = wallPayload(m);
    expect(w.lines[0].label).toBe("AI CODING");
    expect(w).not.toHaveProperty("host");
    expect(Object.keys(w).sort()).toEqual(
      ["bill_cents", "counts", "date", "hero_cents", "id", "lines", "mode", "more_cents", "more_count", "overruled"],
    );
  });
});
