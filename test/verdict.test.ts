import { describe, expect, test } from "bun:test";
import type { CatalogEntry, KeepWalls, Subscription } from "../src/types.ts";
import { BESPOKE_MAX_LENGTH, bespokeReason, catalogVerdict, isThinInbox, matchCatalog, rubricVerdict } from "../src/verdict.ts";

const NO_WALLS: KeepWalls = {
  money_movement: false,
  network_effects: false,
  hardware_coupling: false,
  high_failure_cost: false,
};

describe("rubricVerdict", () => {
  test("any single wall forces KEEP regardless of cost or hours", () => {
    for (const wall of Object.keys(NO_WALLS) as (keyof KeepWalls)[]) {
      const r = rubricVerdict({ ...NO_WALLS, [wall]: true }, 1, 10000);
      expect(r.verdict).toBe("KEEP");
      expect(r.source).toBe("rubric");
    }
  });

  test("under 4 hours, no walls: KILL even when cheap or unpriced", () => {
    expect(rubricVerdict(NO_WALLS, 2, 500).verdict).toBe("KILL");
    expect(rubricVerdict(NO_WALLS, 3, null).verdict).toBe("KILL");
  });

  test("4-12 hours: KILL above $10/mo, TRIM at or below", () => {
    expect(rubricVerdict(NO_WALLS, 8, 1500).verdict).toBe("KILL");
    expect(rubricVerdict(NO_WALLS, 8, 1000).verdict).toBe("TRIM");
    expect(rubricVerdict(NO_WALLS, 12, 800).verdict).toBe("TRIM");
  });

  test("4-12 hours with unverified price: conservative TRIM", () => {
    const r = rubricVerdict(NO_WALLS, 8, null);
    expect(r.verdict).toBe("TRIM");
    expect(r.reason).toContain("unverified");
  });

  test("over 12 hours: TRIM above $20/mo, KEEP at or below", () => {
    expect(rubricVerdict(NO_WALLS, 20, 5000).verdict).toBe("TRIM");
    expect(rubricVerdict(NO_WALLS, 20, 1000).verdict).toBe("KEEP");
    expect(rubricVerdict(NO_WALLS, 20, null).verdict).toBe("KEEP");
  });

  test("reasons carry the user's real price", () => {
    expect(rubricVerdict(NO_WALLS, 8, 1999).reason).toContain("$19.99/mo");
  });
});

const chatbotEntry: CatalogEntry = {
  slug: "fictional-chatbot",
  name: "Fictional Chatbot",
  aliases: ["Fictional AI", "FICTIONAL AI PTE. LTD."],
  category: "ai-assistant",
  typical_price_monthly: 19,
  price_basis: "advertised monthly plan",
  verdict: "KILL",
  verdict_reason: "KILL: your Zo already runs frontier models",
  what_zo_builds: "nothing; it is already the thing",
  hours_to_build: 0,
  annual_savings: 228,
  dont_kill_if: "you depend on its long-context file chat daily",
  build_brief: "...",
  sources: ["https://example.com"],
};

describe("catalog", () => {
  test("catalog hit is an instant verdict with source catalog", () => {
    const r = catalogVerdict(chatbotEntry);
    expect(r.verdict).toBe("KILL");
    expect(r.source).toBe("catalog");
  });

  test("matchCatalog resolves processor legal names via aliases", () => {
    expect(matchCatalog("FICTIONAL AI PTE. LTD.", [chatbotEntry])).toBe(chatbotEntry);
    expect(matchCatalog("Fictional Chatbot", [chatbotEntry])).toBe(chatbotEntry);
    expect(matchCatalog("Notion Labs", [chatbotEntry])).toBeNull();
  });
});

describe("isThinInbox", () => {
  const sub = (user_state: Subscription["user_state"]): Subscription => ({
    merchant: "X",
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
    user_state,
    verdict: null,
    verdict_reason: null,
    verdict_overruled: false,
    included_in_receipt: false,
  });

  test("counts only confirmed rows against the threshold", () => {
    expect(isThinInbox([sub("confirmed"), sub("confirmed"), sub("confirmed")])).toBe(true);
    expect(isThinInbox([sub("confirmed"), sub("confirmed"), sub("confirmed"), sub("confirmed")])).toBe(false);
    expect(isThinInbox([sub("pending"), sub("excluded"), sub("private"), sub("pending")])).toBe(true);
  });
});

describe("bespokeReason", () => {

  test("clean line gets the rubric verdict stamped on front", () => {
    expect(bespokeReason("a booking page is one route on your Zo", "KILL", 1200, 4)).toBe(
      "KILL: a booking page is one route on your Zo",
    );
  });

  test("agent-typed verdict prefix is stripped; the stamp cannot disagree", () => {
    expect(bespokeReason("KEEP: sunk cost is not a wall", "KILL", 1200, 4)).toBe(
      "KILL: sunk cost is not a wall",
    );
  });

  test("tokens fill from script math, never the model", () => {
    expect(bespokeReason("{mo} rents what a {hrs}-hour build owns", "KILL", 1500, 3)).toBe(
      "KILL: $15.00/mo rents what a 3-hour build owns",
    );
    expect(bespokeReason("{yr} back", "KILL", 1000, 2)).toBe("KILL: $120.00/yr back");
  });

  test("hand-typed dollar amounts reject the whole line", () => {
    expect(bespokeReason("costs $15 a month for nothing", "KILL", 1500, 3)).toBeNull();
    expect(bespokeReason("costs $ 15", "KILL", 1500, 3)).toBeNull();
    expect(bespokeReason("costs 15 dollars a month", "KILL", 1500, 3)).toBeNull();
    expect(bespokeReason("takes 3 hours to replace", "KILL", 1500, 3)).toBeNull();
  });

  test("money tokens without a verified price reject; hours token survives", () => {
    expect(bespokeReason("{mo} is rent", "TRIM", null, 8)).toBeNull();
    expect(bespokeReason("a {hrs}-hour build replaces it", "TRIM", null, 8)).toBe(
      "TRIM: a 8-hour build replaces it",
    );
  });

  test("empty, multiline, and oversized lines reject", () => {
    expect(bespokeReason(undefined, "KILL", 1000, 2)).toBeNull();
    expect(bespokeReason("   ", "KILL", 1000, 2)).toBeNull();
    expect(bespokeReason("two\nlines", "KILL", 1000, 2)).toBeNull();
    expect(bespokeReason("x".repeat(BESPOKE_MAX_LENGTH + 1), "KILL", 1000, 2)).toBeNull();
    expect(bespokeReason("x".repeat(BESPOKE_MAX_LENGTH - 5), "KILL", 1000, 2)).toBeNull();
  });
});
