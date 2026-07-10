import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEmail, type RawEmail } from "../src/parse.ts";

// Runs against real receipt bodies kept OUTSIDE this repo (private scan data),
// including the expected merchants, amounts, and receipt numbers. Skips
// cleanly anywhere those files don't exist.

const SAMPLES_DIR = join(import.meta.dir, "../../data/scan/samples");

interface SampleCase {
  name: string;
  merchant: string;
  amount: number;
  receipt: string;
}

function loadManifest(): SampleCase[] {
  const path = join(SAMPLES_DIR, "manifest.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSample(name: string): RawEmail | null {
  const path = join(SAMPLES_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { id: raw.id, sender: raw.sender, subject: raw.subject, date: raw.date, body: raw.plaintextBody };
}

const cases = loadManifest();

describe("real receipt bodies", () => {
  test.skipIf(cases.length > 0)("skipped: no private samples on this machine", () => {});
  for (const c of cases) {
    const email = loadSample(c.name);
    test.skipIf(!email)(`${c.name}: merchant, paid amount, receipt number`, () => {
      const ev = parseEmail(email!);
      expect(ev.kind).toBe("receipt");
      expect(ev.merchant).toBe(c.merchant);
      expect(ev.amount).toBe(c.amount);
      expect(ev.receipt_number).toBe(c.receipt);
    });
  }
});
