// Ship step: bundle the catalog into engine/catalog.json. A cloned engine has
// no ../catalog directory, and without this file verdict.ts silently degrades
// to rubric-only for every visitor.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogEntry } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const SRC = process.env.KILL_LIST_CATALOG_SRC ?? join(ROOT, "catalog", "entries");

const REQUIRED: (keyof CatalogEntry)[] = [
  "slug",
  "name",
  "category",
  "typical_price_monthly",
  "price_basis",
  "verdict",
  "verdict_reason",
  "what_zo_builds",
  "hours_to_build",
  "annual_savings",
  "dont_kill_if",
  "build_brief",
  "sources",
];

export function bundleCatalog(srcDir: string): { entries: CatalogEntry[]; problems: string[] } {
  const problems: string[] = [];
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".json")).sort()) {
    const entry = JSON.parse(readFileSync(join(srcDir, file), "utf8")) as CatalogEntry;
    for (const key of REQUIRED) {
      if (entry[key] === undefined || entry[key] === null || entry[key] === "") {
        problems.push(`${file}: missing ${key}`);
      }
    }
    if (entry.slug !== file.replace(/\.json$/, "")) problems.push(`${file}: slug "${entry.slug}" does not match filename`);
    if (seen.has(entry.slug)) problems.push(`${file}: duplicate slug "${entry.slug}"`);
    seen.add(entry.slug);
    if (!["KILL", "KEEP", "TRIM", "SKIP"].includes(entry.verdict)) problems.push(`${file}: bad verdict "${entry.verdict}"`);
    if (entry.sources && entry.sources.length === 0) problems.push(`${file}: no sources`);
    entries.push(entry);
  }
  return { entries, problems };
}

if (import.meta.main) {
  if (!existsSync(SRC)) {
    console.error(`no catalog source at ${SRC} (set KILL_LIST_CATALOG_SRC)`);
    process.exit(1);
  }
  const { entries, problems } = bundleCatalog(SRC);
  if (problems.length > 0) {
    console.error(`catalog has ${problems.length} problem(s); not writing:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const outPath = join(ROOT, "catalog.json");
  writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n");
  const kills = entries.filter((e) => e.verdict === "KILL");
  const annual = kills.reduce((sum, e) => sum + e.annual_savings, 0);
  console.log(`wrote ${outPath}: ${entries.length} entries, ${kills.length} KILL, $${annual.toFixed(2)}/yr on the table`);
}
