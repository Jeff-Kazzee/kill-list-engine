import { monthlyEquivalent, tokenToCents } from "./money.ts";
import { IGNORE_SENDERS } from "./queries.ts";
import type { Cadence, Confidence, Subscription, SubscriptionStatus } from "./types.ts";

export type EmailKind =
  | "receipt"
  | "failure"
  | "refund"
  | "reminder"
  | "trial"
  | "cancellation"
  | "credit_note"
  | "ignore";

export interface RawEmail {
  id: string;
  sender: string; // "Name <addr@x.com>" or bare address
  subject: string;
  date: string; // ISO 8601
  body?: string; // plaintext
}

export interface ChargeEvent {
  kind: EmailKind;
  merchant: string | null;
  amount: number | null; // integer cents; null means unverified
  date: string;
  receipt_number: string | null;
  msg_id: string;
}

const MONEY_IN_TEXT = /-?(?:US\$ ?|\$)-?\d[\d,]*(?:\.\d{1,2})?(?!\.?\d)/;

const RECEIPT_SUBJECT = /^your receipt from (.+?)(?:\s+#([\w-]+))?$/i;
const FAILURE_SUBJECT = /^your (\S+) payment to (.+?) was unsuccessful/i;
const REFUND_SUBJECT = /^your (.+?) refund\b/i;

function senderAddress(sender: string): string {
  const m = sender.match(/<([^>]+)>/);
  return (m ? m[1] : sender).trim().toLowerCase();
}

function senderDisplayName(sender: string): string | null {
  const m = sender.match(/^"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
}

export function classify(email: RawEmail): EmailKind {
  const addr = senderAddress(email.sender);
  const subject = email.subject;

  if ((IGNORE_SENDERS as readonly string[]).includes(addr)) return "ignore";

  // Stripe-template local parts; merchants reuse them on their own domains
  // (failed-payments@merchant.example, invoice+statements@mail.merchant.example).
  const local = addr.split("@")[0];
  if (local.startsWith("invoice+statements")) return "receipt";
  if (local.startsWith("receipts")) return /refund/i.test(subject) ? "refund" : "receipt";
  if (local.startsWith("failed-payments")) return "failure";
  if (local.startsWith("upcoming-invoice")) return "reminder";
  if (local.startsWith("trial-ending")) return "trial";
  if (local.startsWith("subscription-canceled")) return "cancellation";
  if (local.startsWith("billing+") && addr.endsWith("@stripe.com")) return "credit_note";

  if (addr === "googleplay-noreply@google.com") {
    if (/declined/i.test(subject)) return "failure";
    return /receipt|charged/i.test(subject) ? "receipt" : "ignore";
  }

  if (FAILURE_SUBJECT.test(subject)) return "failure";
  if (RECEIPT_SUBJECT.test(subject)) return "receipt";
  if (/credit note/i.test(subject)) return "credit_note";
  if (/refund/i.test(subject)) return "refund";
  if (/payment (failure|was declined)|\b(2nd|3rd|\dth|last) attempt/i.test(subject)) return "failure";
  if (/\brenew(s|al|ing)?\b|upcoming invoice/i.test(subject)) return "reminder";
  if (/trial.*(end|expir)/i.test(subject)) return "trial";
  if (/cancel(l?ed|lation)?/i.test(subject)) return "cancellation";
  if (/\breceipt\b|\binvoice\b|payment (received|confirmation)/i.test(subject)) return "receipt";
  return "ignore";
}

function labeledAmount(body: string, label: string): number | null {
  const re = new RegExp(`${label}\\s*(${MONEY_IN_TEXT.source})`, "i");
  const m = body.match(re);
  return m ? tokenToCents(m[1]) : null;
}

function amountAfter(body: string, keyword: RegExp): number | null {
  const at = body.search(keyword);
  if (at < 0) return null;
  const m = body.slice(at).match(new RegExp(MONEY_IN_TEXT.source));
  return m ? tokenToCents(m[0]) : null;
}

// Priority order is the whole game: "Amount paid" is the money that moved.
// "Total" is second. "Subtotal" is never acceptable (coupons and credit
// grants sit between it and reality).
function receiptAmount(body: string): number | null {
  return (
    labeledAmount(body, "amount paid") ??
    labeledAmount(body, "(?<!sub)total:?") ??
    amountAfter(body, /you've been charged|charged/i)
  );
}

function receiptNumber(subject: string, body: string | undefined): string | null {
  const s = subject.match(/#([\w-]*\d[\w-]*)/);
  if (s) return s[1];
  const b = body?.match(/receipt (?:number|#):?\s*#?([\w-]*\d[\w-]*)/i);
  return b ? b[1] : null;
}

export function parseEmail(email: RawEmail): ChargeEvent {
  const kind = classify(email);
  const addr = senderAddress(email.sender);
  let merchant: string | null = senderDisplayName(email.sender);
  let amount: number | null = null;

  if (addr === "googleplay-noreply@google.com") merchant = "Google Play";

  if (kind === "failure") {
    const m = email.subject.match(FAILURE_SUBJECT);
    if (m) {
      amount = tokenToCents(m[1]);
      merchant = m[2];
    }
  } else if (kind === "receipt") {
    const m = email.subject.match(RECEIPT_SUBJECT);
    if (m) merchant = m[1];
    if (email.body) amount = receiptAmount(email.body);
  } else if (kind === "refund") {
    const m = email.subject.match(REFUND_SUBJECT);
    if (m) merchant = m[1];
    if (email.body) {
      amount = labeledAmount(email.body, "amount refunded") ?? labeledAmount(email.body, "refund(?:ed)? of");
    }
  } else if (kind === "reminder" && email.body) {
    amount = labeledAmount(email.body, "amount due");
  }

  return {
    kind,
    merchant,
    amount,
    date: email.date,
    receipt_number: kind === "ignore" ? null : receiptNumber(email.subject, email.body),
    msg_id: email.id,
  };
}

const DUPE_WINDOW_MS = 90_000;

// Two dedupe rules, both observed in a real inbox:
// 1. identical receipt number (forwarded or re-sent mail);
// 2. same amount within 90 seconds (processor and platform both emailing
//    the same charge under different merchant names, 5s apart in the wild).
export function dedupe(events: ChargeEvent[]): ChargeEvent[] {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const kept: ChargeEvent[] = [];
  const seenNumbers = new Set<string>();

  for (const ev of sorted) {
    if (ev.kind !== "receipt") {
      kept.push(ev);
      continue;
    }
    if (ev.receipt_number) {
      if (seenNumbers.has(ev.receipt_number)) continue;
      seenNumbers.add(ev.receipt_number);
    }
    const twin = kept.find(
      (k) =>
        k.kind === "receipt" &&
        k.amount !== null &&
        k.amount === ev.amount &&
        Math.abs(Date.parse(k.date) - Date.parse(ev.date)) <= DUPE_WINDOW_MS,
    );
    if (twin) continue;
    kept.push(ev);
  }
  return kept;
}

export function parseEmails(emails: RawEmail[]): ChargeEvent[] {
  return dedupe(emails.map(parseEmail).filter((e) => e.kind !== "ignore"));
}

const LEGAL_SUFFIXES = /\b(inc|llc|ltd|pte|corp|corporation|pbc|gmbh|co)\b\.?/gi;

export function merchantKey(name: string): string {
  return name
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, "")
    .replace(/[.,'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const DAY_MS = 86_400_000;

function inferCadence(chargeDates: string[]): Cadence {
  if (chargeDates.length < 2) return "unknown";
  const gaps: number[] = [];
  for (let i = 1; i < chargeDates.length; i++) {
    gaps.push((Date.parse(chargeDates[i]) - Date.parse(chargeDates[i - 1])) / DAY_MS);
  }
  gaps.sort((a, b) => a - b);
  const median =
    gaps.length % 2 === 1
      ? gaps[(gaps.length - 1) / 2]
      : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  if (median >= 5 && median <= 10) return "weekly";
  if (median >= 20 && median <= 45) return "monthly";
  if (median >= 75 && median <= 105) return "quarterly";
  if (median >= 330 && median <= 400) return "annual";
  return "unknown";
}

const ACTIVE_WINDOW_DAYS: Record<Cadence, number> = {
  weekly: 11,
  monthly: 45,
  quarterly: 135,
  annual: 550,
  unknown: 45,
};

function modeAmount(amounts: number[]): number | null {
  if (amounts.length === 0) return null;
  const counts = new Map<number, number>();
  for (const a of amounts) counts.set(a, (counts.get(a) ?? 0) + 1);
  let best = amounts[amounts.length - 1];
  let bestCount = 0;
  for (const [a, c] of counts) {
    if (c > bestCount || (c === bestCount && amounts.lastIndexOf(a) > amounts.lastIndexOf(best))) {
      best = a;
      bestCount = c;
    }
  }
  return best;
}

function isoDay(date: string): string {
  return date.slice(0, 10);
}

export function buildLedger(events: ChargeEvent[], scanDate: string): Subscription[] {
  const groups = new Map<string, ChargeEvent[]>();
  for (const ev of events) {
    if (!ev.merchant) continue;
    const key = merchantKey(ev.merchant);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(ev);
    else groups.set(key, [ev]);
  }

  const scanMs = Date.parse(scanDate);
  const ledger: Subscription[] = [];

  for (const group of groups.values()) {
    group.sort((a, b) => a.date.localeCompare(b.date));
    const charges = group.filter((e) => e.kind === "receipt" && e.amount !== 0);
    const last = group[group.length - 1];
    const lastCharge = charges[charges.length - 1];

    const chargeAmounts = charges.map((c) => c.amount).filter((a): a is number => a !== null);
    const failureAmounts = group
      .filter((e) => e.kind === "failure" && e.amount !== null)
      .map((e) => e.amount as number);

    const amount =
      charges.length > 0
        ? (lastCharge.amount ?? modeAmount(chargeAmounts))
        : modeAmount(failureAmounts);

    const cadence = inferCadence(charges.map((c) => c.date));

    let status: SubscriptionStatus;
    if (last.kind === "cancellation" || last.kind === "credit_note" || last.kind === "refund") {
      status = "cancelled";
    } else {
      const anchor = lastCharge ?? last;
      const ageDays = (scanMs - Date.parse(anchor.date)) / DAY_MS;
      status = ageDays <= ACTIVE_WINDOW_DAYS[cadence] && charges.length > 0 ? "active" : "lapsed";
    }

    let confidence: Confidence;
    if (amount === null || charges.length === 0) confidence = "low";
    else if (charges.length >= 3) confidence = "high";
    else confidence = "medium";

    ledger.push({
      merchant: group.find((e) => e.merchant)?.merchant ?? "",
      amount: amount === null ? null : amount / 100,
      currency: "USD",
      cadence,
      monthly_equivalent:
        amount === null ? null : (() => { const me = monthlyEquivalent(amount, cadence); return me === null ? null : me / 100; })(),
      first_seen: isoDay(group[0].date),
      last_charge: isoDay((lastCharge ?? last).date),
      charge_count: charges.length,
      status,
      confidence,
      source_msg_ids: group.map((e) => e.msg_id),
      category: "",
      user_state: "pending",
      verdict: null,
      verdict_reason: null,
      verdict_overruled: false,
      included_in_receipt: false,
    });
  }

  return ledger.sort((a, b) => (b.monthly_equivalent ?? 0) - (a.monthly_equivalent ?? 0));
}
