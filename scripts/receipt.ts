// Stage 6: print the receipt. Reads the stamped ledger, renders PNGs at both
// share sizes, and writes the sanitized Wall payload. All math upstream.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { formatUSD } from "../src/money.ts";
import {
  buildKillModel,
  buildProspectModel,
  receiptSVG,
  wallPayload,
  type ReceiptModel,
} from "../src/receipt.ts";
import { loadCatalog } from "./verdict.ts";
import { ping } from "./ping.ts";
import type { LedgerFile } from "./scan.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = process.env.KILL_LIST_OUT ?? join(ROOT, "out");
const FONTS = join(ROOT, "assets", "fonts");

const SIZES = [
  { width: 1080, height: 1350 },
  { width: 1600, height: 900 },
];

export function renderPNG(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [
        join(FONTS, "JetBrainsMono-Regular.ttf"),
        join(FONTS, "JetBrainsMono-Bold.ttf"),
        join(FONTS, "SpaceGrotesk-Medium.ttf"),
        join(FONTS, "SpaceGrotesk-Bold.ttf"),
      ],
      loadSystemFonts: false,
      defaultFontFamily: "JetBrains Mono",
    },
  });
  return resvg.render().asPng();
}

function writeSet(model: ReceiptModel, dir: string, prefix: string): string[] {
  const written: string[] = [];
  for (const size of SIZES) {
    const png = renderPNG(receiptSVG(model, size));
    const path = join(dir, `${prefix}-${size.width}x${size.height}.png`);
    writeFileSync(path, png);
    written.push(path);
  }
  return written;
}

if (import.meta.main) {
  const ledgerPath = join(OUT, "ledger.json");
  if (!existsSync(ledgerPath)) {
    console.error("no out/ledger.json: run scan and verdict stages first");
    process.exit(1);
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as LedgerFile;
  if (ledger.meta.mode === null) {
    console.error("ledger has no mode: run bun scripts/verdict.ts first");
    process.exit(1);
  }

  const dir = join(OUT, "receipt");
  mkdirSync(dir, { recursive: true });

  let full: ReceiptModel;
  let sanitized: ReceiptModel;
  if (ledger.meta.mode === "prospect") {
    const prospectsPath = join(OUT, "prospects.json");
    if (!existsSync(prospectsPath)) {
      console.error(
        "prospect mode needs out/prospects.json: { \"slugs\": [\"notion\", ...] } picked from the catalog",
      );
      process.exit(1);
    }
    const { slugs } = JSON.parse(readFileSync(prospectsPath, "utf8")) as { slugs: string[] };
    const catalog = loadCatalog();
    full = buildProspectModel(slugs, catalog, {});
    sanitized = buildProspectModel(slugs, catalog, { sanitize: true });
  } else {
    full = buildKillModel(ledger.subscriptions, {});
    sanitized = buildKillModel(ledger.subscriptions, { sanitize: true });
  }

  if (full.lines.length === 0) {
    console.error("nothing to print: no confirmed, included rows with verdicts in the ledger");
    process.exit(1);
  }

  const files = [...writeSet(full, dir, "receipt"), ...writeSet(sanitized, dir, "receipt-sanitized")];
  const wallPath = join(dir, "wall.json");
  writeFileSync(wallPath, JSON.stringify(wallPayload(sanitized), null, 2) + "\n");

  await ping("receipt_ready");

  const heroLabel = full.mode === "prospect" ? "ZO CAN PREVENT" : "ZO CAN KILL";
  console.log(`receipt ${full.id} (${full.mode} mode)`);
  console.log(`  MONTHLY BILL  ${formatUSD(full.bill_cents)}/mo`);
  console.log(`  ${heroLabel.padEnd(13)} ${formatUSD(full.hero_cents)}/mo = ${formatUSD(full.hero_cents * 12)}/yr`);
  for (const f of files) console.log(`  wrote ${f}`);
  console.log(`  wrote ${wallPath} (sanitized Wall payload, pushed only on explicit consent)`);
}
