# The Kill List engine

This is the code your Zo runs when you connect it to [The Kill List](https://kill-list-jeffkazzee.zocomputer.io). It scans your own Gmail for subscription receipts, on your own machine, and stamps every bill KILL, KEEP, or TRIM.

You are probably here because the site told you to read the source first. Good instinct. Start with [SKILL.md](SKILL.md). It is the entire contract between you, your Zo, and the site.

The short version:

- Read-only Gmail. The engine never modifies, sends, or deletes anything.
- No model math. Every dollar amount is parsed and summed by plain string code you can read in `src/money.ts` and `src/parse.ts`.
- Nothing personal leaves your machine. The site receives seven fixed status strings (`connected`, `scanning`, `parsing`, `reviewing`, `stamping`, `prospect`, `receipt_ready`) and nothing else, ever.
- The review cockpit deploys as a private route on your Zo. The site never sees it.
- Posting your receipt to the public Wall is a separate, explicit choice, the payload is sanitized to category labels and whole dollars, and a human approves it before it appears.

## Run it

```
git clone https://github.com/Jeff-Kazzee/kill-list-engine /home/workspace/kill-list
cd /home/workspace/kill-list && bun install
bun test
```

Then follow SKILL.md. Tests run on synthetic fixtures; no real inbox data ships in this repo.

Built for the Zo July Build Challenge: Kill Your SaaS.
