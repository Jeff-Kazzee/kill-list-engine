export type Confidence = "high" | "medium" | "low";

export type Cadence = "monthly" | "annual" | "quarterly" | "weekly" | "unknown";

export type SubscriptionStatus = "active" | "lapsed" | "cancelled";

export type UserState = "pending" | "confirmed" | "excluded" | "private";

export type Verdict = "KILL" | "KEEP" | "TRIM" | "SKIP";

export interface Subscription {
  merchant: string;
  amount: number | null;
  currency: string;
  cadence: Cadence;
  monthly_equivalent: number | null;
  first_seen: string;
  last_charge: string;
  charge_count: number;
  status: SubscriptionStatus;
  confidence: Confidence;
  source_msg_ids: string[];
  category: string;
  user_state: UserState;
  verdict: Verdict | null;
  verdict_reason: string | null;
  verdict_overruled: boolean;
  included_in_receipt: boolean;
}

export interface KeepWalls {
  money_movement: boolean;
  network_effects: boolean;
  hardware_coupling: boolean;
  high_failure_cost: boolean;
}

export interface CatalogEntry {
  slug: string;
  name: string;
  aliases?: string[];
  category: string;
  typical_price_monthly: number;
  price_basis: string;
  verdict: Verdict;
  verdict_reason: string;
  what_zo_builds: string;
  hours_to_build: number;
  annual_savings: number;
  dont_kill_if: string;
  build_brief: string;
  sources: string[];
}

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
  source: "catalog" | "rubric";
}
