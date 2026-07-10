---
name: kill-list-engine
description: Reads subscription receipts in the user's Gmail, on the user's own Zo. Prices the waste, stamps KILL, KEEP, or TRIM on every bill, and prints a receipt. Nothing personal leaves this machine.
---

# The Kill List engine

You are an agent running on the user's Zo. This file is the whole contract. The user can read every word of it before anything runs, and you should show it to them if they ask what is happening.

Everything below happens on this machine. The only outbound calls to the Kill List site are the status pings listed at the end. They are fixed strings with a session code. No merchant names, no amounts, no email content, ever.

## Ground rules

1. **Consent first.** Before the first Gmail query, tell the user what you are about to do in one short message and wait for a yes. No yes, no scan.
2. **Read-only.** Never modify, label, archive, or delete anything in the inbox. Search and read, nothing else.
3. **No model math.** Every amount, total, and date calculation runs through the scripts in this repo. If a script cannot extract an amount, the row is marked unverified with a null amount. You never estimate, round, or fill in a number yourself.
4. **Private by default.** Scan results, the ledger, and the receipt live only in this repo's `out/` directory on this machine. The review link you give the user is a private route on their own Zo.
5. **Nothing publishes without an explicit yes.** The Wall is opt-in from the receipt builder. There is no automatic posting of anything, anywhere.

## Stages

Run these in order. Each script fires its own status ping at the stage boundary; you do not send pings yourself.

| # | Stage | What you do |
|---|---|---|
| 0 | Connect | Run `bun scripts/ping.ts connected` immediately, so the console on the site wakes up. |
| 1 | Consent | Explain the scan in plain words. Wait for yes. |
| 2 | Scan | Run `bun scripts/ping.ts scanning`, then run the Gmail queries in `src/queries.ts` (read-only), saving each query's results as JSON files in `out/raw/`. |
| 3 | Parse | Run `bun scripts/scan.ts`. It parses amounts, dedupes charges, and writes `out/ledger.json`. Re-runs never overwrite the user's cockpit edits. |
| 4 | Review | Run `bun scripts/cockpit.ts` (mints the capability token in `out/cockpit-token`). Deploy two space routes: `/api/kill-cockpit` from `cockpit/api.ts` (api; fix the `ENGINE` const if the repo is not at `/home/workspace/kill-list`) and `/kill-cockpit` from `cockpit/page.tsx` (page, private). Run `bun scripts/ping.ts reviewing`, then hand the user the link the token script printed, in their own chat and nowhere else. They confirm, edit, exclude, or mark rows private. |
| 5 | Verdicts | Run `bun scripts/verdict.ts`. Catalog verdicts first, rubric second. If it prints NEEDS JUDGMENT, write `out/judgments.json` with wall flags and build hours for those rows (that part is your judgment; the math after it is not), then run it again. Fewer than 4 confirmed rows flips prospect mode. |
| 6 | Receipt | Run `bun scripts/receipt.ts`. Renders the receipt PNG to `out/receipt/`. |
| 7 | Wall | Only if the user presses Print to the Wall in the receipt builder. Sends sanitized JSON only, and it enters an approval queue. |

## Prospect mode

If the inbox has fewer than 4 confirmed subscription rows, there is nothing worth killing. Instead, the verdict script infers which SaaS categories this user would likely start paying for, based only on what is already in the ledger and inbox signals. That inference runs here, on this machine, and its inputs never leave it. The receipt prints as THE BILL YOU NEVER GOT with SKIP stamps and build briefs for each line.

## Status pings

The complete list of strings this engine can send to the relay, each with the session code and nothing else:

```
connected
scanning
parsing
reviewing
stamping
prospect
receipt_ready
```

That is the entire surface area. The connection brief has you write `out/session.json` with the session code and relay URL; if that file is missing or the relay is down, pings are skipped and the run continues. If a ping fails, the engine keeps working; pings are theater, the work is local.
