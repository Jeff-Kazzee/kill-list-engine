import type { Cadence } from "./types.ts";

// String-based parsing only: no floats until the value is integer cents.
const MONEY_TOKEN =
  /^(?:US\$ ?|USD ?|\$)?(-)?(?:US\$ ?|\$)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

export function tokenToCents(token: string): number | null {
  const m = token.trim().match(MONEY_TOKEN);
  if (!m) return null;
  const [, sign, whole, frac] = m;
  const dollars = parseInt(whole.replace(/,/g, ""), 10);
  const cents = frac ? parseInt(frac.padEnd(2, "0"), 10) : 0;
  const total = dollars * 100 + cents;
  return sign ? -total : total;
}

export function formatUSD(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${frac}`;
}

export function monthlyEquivalent(cents: number, cadence: Cadence): number | null {
  switch (cadence) {
    case "monthly":
      return cents;
    case "annual":
      return Math.round(cents / 12);
    case "quarterly":
      return Math.round(cents / 3);
    case "weekly":
      return Math.round((cents * 52) / 12);
    case "unknown":
      return null;
  }
}
