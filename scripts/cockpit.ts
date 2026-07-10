// Stage 4 helper: mint the cockpit capability token. Space API routes are
// always public, so the cockpit API refuses every request that does not
// carry this token. It lives in out/ and never leaves this machine except
// inside the private cockpit link handed to the user in their own chat.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.KILL_LIST_OUT ?? join(import.meta.dir, "..", "out");

export function ensureToken(): string {
  const path = join(OUT, "cockpit-token");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OUT, { recursive: true });
  const token = randomBytes(16).toString("hex");
  writeFileSync(path, token + "\n");
  return token;
}

if (import.meta.main) {
  const token = ensureToken();
  console.log("cockpit token ready: out/cockpit-token");
  console.log("");
  console.log("deploy (SKILL.md stage 4):");
  console.log("  1. api route   /api/kill-cockpit  from cockpit/api.ts (check the ENGINE const)");
  console.log("  2. page route  /kill-cockpit      from cockpit/page.tsx, private");
  console.log("  3. hand the user this link in their own chat, nowhere else:");
  console.log("");
  console.log(`  https://YOUR-HANDLE.zo.space/kill-cockpit?t=${token}`);
}
