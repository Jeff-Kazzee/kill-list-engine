import { describe, expect, test } from "bun:test";
import {
  buildLedger,
  classify,
  dedupe,
  merchantKey,
  parseEmail,
  parseEmails,
  type RawEmail,
} from "../src/parse.ts";

// Synthetic fixtures only. Formats mirror real mail observed in a 12-month
// inbox; merchants, numbers, and accounts are invented.

const stripeReceipt: RawEmail = {
  id: "m1",
  sender: "Acme AI <invoice+statements+acct_1FAKE@stripe.com>",
  subject: "Your receipt from Acme AI Inc. #2001-4477",
  date: "2026-06-07T22:53:18Z",
  body: "Receipt from Acme AI Inc. $20.00 Paid June 7, 2026 Receipt number 2001-4477 Invoice number FAKEFAKE-0003 Pro Qty 1 $20.00 Total $20.00 Amount paid $20.00",
};

const meteredCouponReceipt: RawEmail = {
  id: "m2",
  sender: "Fictional Cloud <invoice+statements+acct_2FAKE@stripe.com>",
  subject: "Your receipt from Fictional Cloud #9415-0001",
  date: "2026-06-11T15:47:16Z",
  body: "Receipt from Fictional Cloud $5.00 Paid June 11, 2026 Receipt number 9415-0001 Widget input tokens Qty 123,456,000 $1,234.56 $0.00001 each Widget output tokens Qty 2,000,000 $60.00 $0.00003 each 1 × Ultra License (at $200.00 / month) Qty 1 $200.00 Subtotal $1,494.56 FAKECODE (98% off) -$1,464.67 Credit grant applied -$24.89 Total $5.00 Amount paid $5.00",
};

describe("classify", () => {
  test("stripe template local parts, any domain", () => {
    expect(classify(stripeReceipt)).toBe("receipt");
    expect(
      classify({ id: "x", sender: "failed-payments@fakemerchant.ai", subject: "Your $20.00 payment to Fakemerchant was unsuccessful", date: "2026-07-05T00:00:00Z" }),
    ).toBe("failure");
    expect(
      classify({ id: "x", sender: "upcoming-invoice+acct_1F@stripe.com", subject: "Your Fakemerchant subscription renews soon", date: "2026-06-20T00:00:00Z" }),
    ).toBe("reminder");
    expect(
      classify({ id: "x", sender: "subscription-canceled+acct_1F@stripe.com", subject: "Your Fakemerchant subscription has been canceled", date: "2025-09-25T00:00:00Z" }),
    ).toBe("cancellation");
  });

  test("refund via receipts+ sender needs the subject", () => {
    expect(
      classify({ id: "x", sender: "receipts+acct_1F@stripe.com", subject: "Your Fake Tools, Inc. refund #8137-0001", date: "2026-05-16T00:00:00Z" }),
    ).toBe("refund");
    expect(
      classify({ id: "x", sender: "receipts+acct_1F@stripe.com", subject: "Your receipt from Fake Tools, Inc. #1774-0001", date: "2026-02-25T00:00:00Z" }),
    ).toBe("receipt");
  });

  test("google play: charged vs declined", () => {
    expect(
      classify({ id: "x", sender: "Google Play <googleplay-noreply@google.com>", subject: "Your Google Play Order Receipt from Jan 15, 2026", date: "2026-01-15T00:00:00Z" }),
    ).toBe("receipt");
    expect(
      classify({ id: "x", sender: "Google Play <googleplay-noreply@google.com>", subject: "Transaction was declined", date: "2026-02-20T00:00:00Z" }),
    ).toBe("failure");
  });

  test("notion-style dunning sequences are failures", () => {
    expect(
      classify({ id: "x", sender: "Fakemerchant <billing@mail.fakemerchant.so>", subject: "Payment failure", date: "2026-02-12T00:00:00Z" }),
    ).toBe("failure");
    expect(
      classify({ id: "x", sender: "Fakemerchant <billing@mail.fakemerchant.so>", subject: "Last attempt: update your payment method", date: "2026-04-12T00:00:00Z" }),
    ).toBe("failure");
  });

  test("noise is sender-filtered, not subject-filtered", () => {
    expect(
      classify({ id: "x", sender: "notifications@github.com", subject: "Re: [org/repo] Fix payment retry loop (#123)", date: "2026-03-01T00:00:00Z" }),
    ).toBe("ignore");
    expect(
      classify({ id: "x", sender: "Stripe <notifications@stripe.com>", subject: "Your Stripe verification code", date: "2025-07-25T00:00:00Z" }),
    ).toBe("ignore");
  });
});

describe("parseEmail", () => {
  test("flat stripe receipt: merchant, amount, receipt number", () => {
    const ev = parseEmail(stripeReceipt);
    expect(ev.kind).toBe("receipt");
    expect(ev.merchant).toBe("Acme AI Inc.");
    expect(ev.amount).toBe(2000);
    expect(ev.receipt_number).toBe("2001-4477");
  });

  test("amount paid wins over total and subtotal", () => {
    const ev = parseEmail(meteredCouponReceipt);
    expect(ev.amount).toBe(500);
  });

  test("total is used when amount paid is absent, subtotal never", () => {
    const ev = parseEmail({
      ...meteredCouponReceipt,
      body: "Subtotal $1,494.56 FAKECODE (98% off) -$1,464.67 Total $5.00",
    });
    expect(ev.amount).toBe(500);
  });

  test("negative proration totals parse", () => {
    const ev = parseEmail({
      id: "m3",
      sender: "Fake Hub <noreply@fakehub.com>",
      subject: "[Fake Hub] Payment receipt for Copilot-like thing",
      date: "2026-02-24T00:00:00Z",
      body: "Prorated adjustment. Total: $-3.21",
    });
    expect(ev.kind).toBe("receipt");
    expect(ev.amount).toBe(-321);
  });

  test("failure subject carries price and merchant", () => {
    const ev = parseEmail({
      id: "m4",
      sender: "Deadco <failed-payments+acct_9F@stripe.com>",
      subject: "Your $180.00 payment to Deadco was unsuccessful again",
      date: "2025-09-09T00:00:00Z",
    });
    expect(ev.kind).toBe("failure");
    expect(ev.merchant).toBe("Deadco");
    expect(ev.amount).toBe(18000);
  });

  test("reminder with no amount anywhere stays null", () => {
    const ev = parseEmail({
      id: "m5",
      sender: "FakeMCP <upcoming-invoice+acct_3F@stripe.com>",
      subject: "Your FakeMCP Cloud Hobby subscription renews on June 24",
      date: "2026-06-17T00:00:00Z",
      body: "Your subscription renews soon. Manage your subscription in the billing portal.",
    });
    expect(ev.kind).toBe("reminder");
    expect(ev.amount).toBeNull();
  });

  test("google play intro pricing body", () => {
    const ev = parseEmail({
      id: "m6",
      sender: "Google Play <googleplay-noreply@google.com>",
      subject: "Your Google Play Order Receipt from Jan 15, 2026",
      date: "2026-01-15T00:00:00Z",
      body: "Thank you. You've been charged US$ 4.99/month for 3 months, then US$ 14.99/month.",
    });
    expect(ev.merchant).toBe("Google Play");
    expect(ev.amount).toBe(499);
  });

  test("refund subject", () => {
    const ev = parseEmail({
      id: "m7",
      sender: "receipts+acct_1F@stripe.com",
      subject: "Your Fake Tools, Inc. refund #8137-0001",
      date: "2026-05-16T00:00:00Z",
      body: "Amount refunded $12.34",
    });
    expect(ev.kind).toBe("refund");
    expect(ev.merchant).toBe("Fake Tools, Inc.");
    expect(ev.amount).toBe(1234);
    expect(ev.receipt_number).toBe("8137-0001");
  });
});

describe("dedupe", () => {
  const base: RawEmail = {
    id: "d1",
    sender: "Person Name <receipts+acct_4F@stripe.com>",
    subject: "Your receipt from Person Name #2421-0001",
    date: "2025-09-04T13:45:11Z",
    body: "Total $8.00 Amount paid $8.00",
  };

  test("cross-sender same charge seconds apart collapses to one", () => {
    const platform: RawEmail = {
      id: "d2",
      sender: "Fakestack <no-reply@fakestack.com>",
      subject: "Your receipt from Fake Newsletter #FAKE-0001",
      date: "2025-09-04T13:45:06Z",
      body: "Amount paid $8.00",
    };
    const events = parseEmails([base, platform]);
    expect(events.filter((e) => e.kind === "receipt")).toHaveLength(1);
    expect(events[0].msg_id).toBe("d2");
  });

  test("same receipt number collapses", () => {
    const events = parseEmails([base, { ...base, id: "d3", date: "2025-09-05T09:00:00Z" }]);
    expect(events.filter((e) => e.kind === "receipt")).toHaveLength(1);
  });

  test("same-day distinct receipt numbers hours apart both survive", () => {
    const events = dedupe([
      parseEmail(base),
      parseEmail({
        ...base,
        id: "d4",
        subject: "Your receipt from Person Name #2421-0002",
        date: "2025-09-04T18:02:00Z",
      }),
    ]);
    expect(events).toHaveLength(2);
  });
});

describe("merchantKey", () => {
  test("legal suffixes and punctuation collapse", () => {
    expect(merchantKey("Fictional AI Inc.")).toBe("fictional ai");
    expect(merchantKey("MADEUP AI PTE. LTD.")).toBe("madeup ai");
    expect(merchantKey("Example, PBC")).toBe("example");
    expect(merchantKey("Acme AI")).toBe(merchantKey("Acme AI Inc."));
  });
});

describe("buildLedger", () => {
  const scanDate = "2026-07-10T00:00:00Z";

  function receiptFor(merchant: string, amount: string, date: string, n: string): RawEmail {
    return {
      id: `r-${merchant}-${n}`,
      sender: `${merchant} <invoice+statements+acct_1F@stripe.com>`,
      subject: `Your receipt from ${merchant} #${n}`,
      date,
      body: `Total ${amount} Amount paid ${amount}`,
    };
  }

  test("monthly active subscription from three charges", () => {
    const ledger = buildLedger(
      parseEmails([
        receiptFor("Acme AI Inc.", "$19.99", "2026-04-27T10:00:00Z", "1001-0001"),
        receiptFor("Acme AI Inc.", "$19.99", "2026-05-27T10:00:00Z", "1001-0002"),
        receiptFor("Acme AI", "$19.99", "2026-06-27T10:00:00Z", "1001-0003"),
      ]),
      scanDate,
    );
    expect(ledger).toHaveLength(1);
    const sub = ledger[0];
    expect(sub.cadence).toBe("monthly");
    expect(sub.status).toBe("active");
    expect(sub.confidence).toBe("high");
    expect(sub.charge_count).toBe(3);
    expect(sub.amount).toBe(19.99);
    expect(sub.monthly_equivalent).toBe(19.99);
    expect(sub.first_seen).toBe("2026-04-27");
    expect(sub.last_charge).toBe("2026-06-27");
  });

  test("failure-only zombie: lapsed, low confidence, price from dunning subjects", () => {
    const failure = (date: string, id: string): RawEmail => ({
      id,
      sender: "Deadco <failed-payments+acct_9F@stripe.com>",
      subject: "Your $79.00 payment to Deadco was unsuccessful again",
      date,
    });
    const ledger = buildLedger(
      parseEmails([failure("2025-10-16T00:00:00Z", "f1"), failure("2025-10-17T00:00:00Z", "f2")]),
      scanDate,
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("lapsed");
    expect(ledger[0].confidence).toBe("low");
    expect(ledger[0].charge_count).toBe(0);
    expect(ledger[0].amount).toBe(79);
    expect(ledger[0].monthly_equivalent).toBeNull();
  });

  test("cancellation after last charge marks cancelled", () => {
    const ledger = buildLedger(
      parseEmails([
        receiptFor("Shortlived", "$18.99", "2025-08-26T00:00:00Z", "3001-0001"),
        {
          id: "c1",
          sender: "Shortlived <subscription-canceled+acct_5F@stripe.com>",
          subject: "Your Shortlived subscription has been canceled",
          date: "2025-10-25T00:00:00Z",
        },
      ]),
      scanDate,
    );
    expect(ledger[0].status).toBe("cancelled");
  });

  test("zero-dollar invoices never become charges", () => {
    const ledger = buildLedger(
      parseEmails([
        receiptFor("Freebie CDN", "$0.00", "2026-05-01T00:00:00Z", "4001-0001"),
        receiptFor("Freebie CDN", "$0.00", "2026-06-01T00:00:00Z", "4001-0002"),
      ]),
      scanDate,
    );
    expect(ledger[0].charge_count).toBe(0);
    expect(ledger[0].status).toBe("lapsed");
  });

  test("stale charges go lapsed even without failures", () => {
    const ledger = buildLedger(
      parseEmails([
        receiptFor("Quietquit", "$20.00", "2025-06-22T00:00:00Z", "5001-0001"),
        receiptFor("Quietquit", "$20.00", "2025-07-22T00:00:00Z", "5001-0002"),
        receiptFor("Quietquit", "$20.00", "2025-08-22T00:00:00Z", "5001-0003"),
      ]),
      scanDate,
    );
    expect(ledger[0].cadence).toBe("monthly");
    expect(ledger[0].status).toBe("lapsed");
  });
});
