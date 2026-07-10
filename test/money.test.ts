import { describe, expect, test } from "bun:test";
import { formatUSD, monthlyEquivalent, tokenToCents } from "../src/money.ts";

describe("tokenToCents", () => {
  test("plain dollar amounts", () => {
    expect(tokenToCents("$19.99")).toBe(1999);
    expect(tokenToCents("$8")).toBe(800);
    expect(tokenToCents("$100.00")).toBe(10000);
  });

  test("thousands separators", () => {
    expect(tokenToCents("$1,234.56")).toBe(123456);
    expect(tokenToCents("$2,345.67")).toBe(234567);
  });

  test("negative proration, both sign placements", () => {
    expect(tokenToCents("$-3.21")).toBe(-321);
    expect(tokenToCents("-$3.21")).toBe(-321);
    expect(tokenToCents("-$1,464.67")).toBe(-146467);
  });

  test("Google Play intro pricing format", () => {
    expect(tokenToCents("US$ 6.49")).toBe(649);
    expect(tokenToCents("US$19.99")).toBe(1999);
  });

  test("zero totals", () => {
    expect(tokenToCents("$0.00")).toBe(0);
    expect(tokenToCents("$0")).toBe(0);
  });

  test("bare numbers and single decimal digit", () => {
    expect(tokenToCents("19.99")).toBe(1999);
    expect(tokenToCents("9.6")).toBe(960);
  });

  test("rejects non-money tokens", () => {
    expect(tokenToCents("receipt")).toBeNull();
    expect(tokenToCents("#1234-5678")).toBeNull();
    expect(tokenToCents("$")).toBeNull();
    expect(tokenToCents("$19.999")).toBeNull();
    expect(tokenToCents("1,23.45")).toBeNull();
    expect(tokenToCents("")).toBeNull();
  });

  test("rejects per-token micro-rates (more than 2 decimals)", () => {
    expect(tokenToCents("$0.0000005")).toBeNull();
    expect(tokenToCents("$0.000000435")).toBeNull();
  });
});

describe("formatUSD", () => {
  test("round trips", () => {
    expect(formatUSD(1999)).toBe("$19.99");
    expect(formatUSD(800)).toBe("$8.00");
    expect(formatUSD(123456)).toBe("$1,234.56");
    expect(formatUSD(-321)).toBe("-$3.21");
    expect(formatUSD(0)).toBe("$0.00");
    expect(formatUSD(5)).toBe("$0.05");
  });
});

describe("monthlyEquivalent", () => {
  test("cadence conversion", () => {
    expect(monthlyEquivalent(1999, "monthly")).toBe(1999);
    expect(monthlyEquivalent(12000, "annual")).toBe(1000);
    expect(monthlyEquivalent(3000, "quarterly")).toBe(1000);
    expect(monthlyEquivalent(800, "weekly")).toBe(3467);
    expect(monthlyEquivalent(1999, "unknown")).toBeNull();
  });

  test("annual rounds to nearest cent", () => {
    expect(monthlyEquivalent(10000, "annual")).toBe(833);
  });
});
