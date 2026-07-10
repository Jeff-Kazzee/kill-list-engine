// The kill receipt: deterministic SVG. No browser, no model, no randomness
// that is not seeded by the data itself. Same ledger in, same pixels out.
import { formatUSD } from "./money.ts";
import type { CatalogEntry, Subscription, Verdict } from "./types.ts";

export const SITE_HOST = process.env.KILL_LIST_SITE ?? "kill-list-jeffkazzee.zocomputer.io";

export const PAPER = "#F7F4EC";
export const INK = "#1A1814";
export const KILL = "#C8102E";
export const KEEP = "#6B6660";
export const TRIM = "#B7791F";
export const SAVED = "#1F7A4D";

const STAMP_COLOR: Record<Verdict, string> = {
  KILL: KILL,
  KEEP: KEEP,
  TRIM: TRIM,
  SKIP: KEEP,
};

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// -4deg to +3deg, stable per label. Re-renders never wobble.
export function stampRotation(label: string): number {
  return (fnv1a(label) % 71) / 10 - 4;
}

export interface ReceiptLine {
  label: string;
  monthly_cents: number | null;
  verdict: Verdict;
  overruled: boolean;
}

export interface ReceiptModel {
  id: string;
  date: string;
  window: string;
  mode: "kill" | "prospect";
  sanitized: boolean;
  lines: ReceiptLine[];
  more_count: number;
  more_cents: number;
  bill_cents: number;
  hero_cents: number;
  counts: Record<Verdict, number>;
  overruled: number;
  host: string;
}

const MAX_LINES = 16;

function monthLabel(iso: string): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const d = new Date(iso);
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function sanitizeLabel(sub: Pick<Subscription, "category">): string {
  const c = (sub.category || "subscription").trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return c || "SUBSCRIPTION";
}

function roundCents(cents: number): number {
  return Math.round(cents / 100) * 100;
}

export interface BuildOptions {
  sanitize?: boolean;
  today?: string; // ISO date, defaults to now (injectable for tests)
  host?: string;
}

// Kill mode: only rows the user confirmed in the cockpit, never private ones.
export function receiptRows(subs: Subscription[]): Subscription[] {
  return subs.filter(
    (s) =>
      s.user_state === "confirmed" &&
      s.included_in_receipt &&
      s.verdict !== null &&
      s.verdict !== "SKIP",
  );
}

export function buildKillModel(subs: Subscription[], opts: BuildOptions = {}): ReceiptModel {
  const rows = receiptRows(subs);
  const sanitize = opts.sanitize ?? false;

  const lines: ReceiptLine[] = rows
    .map((s) => {
      const cents = s.monthly_equivalent === null ? null : Math.round(s.monthly_equivalent * 100);
      return {
        label: sanitize ? sanitizeLabel(s) : s.merchant.toUpperCase(),
        monthly_cents: cents === null ? null : sanitize ? roundCents(cents) : cents,
        verdict: s.verdict as Verdict,
        overruled: s.verdict_overruled,
      };
    })
    .sort((a, b) => (b.monthly_cents ?? -1) - (a.monthly_cents ?? -1));

  const windows = rows.flatMap((s) => [s.first_seen, s.last_charge]).filter(Boolean).sort();
  const window =
    windows.length > 0 ? `${monthLabel(windows[0])} - ${monthLabel(windows[windows.length - 1])}` : "NO WINDOW";

  return finishModel(lines, "kill", sanitize, window, opts);
}

// Prospect mode: the agent picks catalog slugs; every price is the catalog's.
export function buildProspectModel(
  slugs: string[],
  catalog: CatalogEntry[],
  opts: BuildOptions = {},
): ReceiptModel {
  const bySlug = new Map(catalog.map((e) => [e.slug, e]));
  const sanitize = opts.sanitize ?? false;
  const lines: ReceiptLine[] = [];
  for (const slug of slugs) {
    const entry = bySlug.get(slug);
    if (!entry) continue;
    const cents = Math.round(entry.typical_price_monthly * 100);
    lines.push({
      label: sanitize ? sanitizeLabel({ category: entry.category }) : entry.name.toUpperCase(),
      monthly_cents: sanitize ? roundCents(cents) : cents,
      verdict: "SKIP",
      overruled: false,
    });
  }
  lines.sort((a, b) => (b.monthly_cents ?? -1) - (a.monthly_cents ?? -1));
  return finishModel(lines, "prospect", sanitize, "PRICED FROM THE KILL INDEX", opts);
}

function finishModel(
  all: ReceiptLine[],
  mode: "kill" | "prospect",
  sanitized: boolean,
  window: string,
  opts: BuildOptions,
): ReceiptModel {
  const lines = all.slice(0, MAX_LINES);
  const more = all.slice(MAX_LINES);
  const more_cents = more.reduce((t, l) => t + (l.monthly_cents ?? 0), 0);

  const bill_cents = all.reduce((t, l) => t + (l.monthly_cents ?? 0), 0);
  const heroVerdict: Verdict = mode === "prospect" ? "SKIP" : "KILL";
  const hero_cents = all
    .filter((l) => l.verdict === heroVerdict)
    .reduce((t, l) => t + (l.monthly_cents ?? 0), 0);

  const counts: Record<Verdict, number> = { KILL: 0, KEEP: 0, TRIM: 0, SKIP: 0 };
  for (const l of all) counts[l.verdict]++;

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const sig = fnv1a(all.map((l) => `${l.label}:${l.monthly_cents}:${l.verdict}`).join("|"))
    .toString(16)
    .toUpperCase()
    .padStart(8, "0")
    .slice(0, 4);
  const id = `KL-${today.replace(/-/g, "")}-${sig}`;

  return {
    id,
    date: today,
    window,
    mode,
    sanitized,
    lines,
    more_count: more.length,
    more_cents,
    bill_cents,
    hero_cents,
    counts,
    overruled: all.filter((l) => l.overruled).length,
    host: opts.host ?? SITE_HOST,
  };
}

// Code 39 patterns, printed as decoration from the receipt id. w = wide.
const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn",
  "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw",
  "8": "wnnwnnwnn", "9": "nnwwnnwnn", A: "wnnnnwnnw", B: "nnwnnwnnw",
  C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn", F: "nnwnwwnnn",
  G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn",
  K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww",
  O: "wnnnwnnwn", P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn",
  S: "nnwnnnwwn", T: "nnnnwnwwn", U: "wwnnnnnnw", V: "nwwnnnnnw",
  W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn", Z: "nwwnwnnnn",
  "-": "nwnnnnwnw", "*": "nwnnwnwnn",
};

export function barcodeBars(text: string): { x: number; w: number }[] {
  const NARROW = 2;
  const WIDE = 5;
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of `*${text.toUpperCase().replace(/[^A-Z0-9-]/g, "")}*`) {
    const pattern = CODE39[ch];
    if (!pattern) continue;
    for (let i = 0; i < 9; i++) {
      const w = pattern[i] === "w" ? WIDE : NARROW;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += NARROW;
  }
  return bars;
}

export function barcodeWidth(text: string): number {
  const bars = barcodeBars(text);
  const last = bars[bars.length - 1];
  return last ? last.x + last.w : 0;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Layout constants: natural paper units, scaled to fit any canvas.
const PW = 640; // paper width
const PAD = 44;
const MONO_CH = 0.6; // JetBrains Mono advance ratio

function moneyLine(cents: number | null): string {
  return cents === null ? "UNVERIFIED" : `${formatUSD(cents)}/mo`;
}

interface Piece {
  svg: string;
  h: number;
}

function dots(fromX: number, toX: number, size: number): string {
  const step = size * MONO_CH;
  const n = Math.max(0, Math.floor((toX - fromX) / step));
  return ".".repeat(n);
}

export interface RenderOptions {
  width: number;
  height: number;
}

export function receiptSVG(m: ReceiptModel, canvas: RenderOptions): string {
  const pieces: Piece[] = [];
  let y = 0;

  const mono = (
    text: string,
    x: number,
    yy: number,
    size: number,
    o: { weight?: number; fill?: string; anchor?: "start" | "middle" | "end"; spacing?: string } = {},
  ) =>
    `<text x="${x}" y="${yy}" font-family="JetBrains Mono" font-size="${size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? INK}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(text)}</text>`;

  const grotesk = (
    text: string,
    x: number,
    yy: number,
    size: number,
    o: { weight?: number; fill?: string; anchor?: "start" | "middle" | "end"; spacing?: string } = {},
  ) =>
    `<text x="${x}" y="${yy}" font-family="Space Grotesk" font-size="${size}" font-weight="${o.weight ?? 700}" fill="${o.fill ?? INK}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(text)}</text>`;

  const rule = (yy: number) =>
    `<line x1="${PAD}" y1="${yy}" x2="${PW - PAD}" y2="${yy}" stroke="${INK}" stroke-width="1.5" stroke-dasharray="2 5"/>`;

  // Header
  y += 66;
  const title = m.mode === "prospect" ? "THE BILL YOU NEVER GOT" : "THE KILL LIST";
  const titleSize = m.mode === "prospect" ? 30 : 38;
  pieces.push({
    svg:
      grotesk(title, PW / 2, y, titleSize, { anchor: "middle", fill: "rgba(255,255,255,0.55)" }).replace(
        `y="${y}"`,
        `y="${y + 1.5}"`,
      ) + grotesk(title, PW / 2, y, titleSize, { anchor: "middle", spacing: "0.04em" }),
    h: 0,
  });
  y += 30;
  pieces.push({
    svg: mono("SUBSCRIPTION AUDIT", PW / 2, y, 13, { anchor: "middle", spacing: "0.18em", fill: KEEP }),
    h: 0,
  });

  // Meta block
  y += 34;
  const meta: [string, string][] = [
    ["AUDIT", m.id],
    ["DATE", m.date],
    ["WINDOW", m.window],
  ];
  if (m.sanitized) meta.push(["MODE", "SANITIZED"]);
  for (const [k, v] of meta) {
    pieces.push({
      svg: mono(k, PAD, y, 13, { fill: KEEP }) + mono(v, PW - PAD, y, 13, { anchor: "end" }),
      h: 0,
    });
    y += 22;
  }
  y += 4;
  pieces.push({ svg: rule(y), h: 0 });

  // Line items
  y += 14;
  const itemSize = 15;
  const stampW = 66;
  const stampH = 24;
  const amountRight = PW - PAD - stampW - 14;
  for (const line of m.lines) {
    y += 26;
    const label = line.label.length > 22 ? line.label.slice(0, 21) + "…" : line.label;
    const amount = moneyLine(line.monthly_cents) + (line.overruled ? "*" : "");
    const labelEnd = PAD + label.length * itemSize * MONO_CH + 6;
    const amountStart = amountRight - amount.length * itemSize * MONO_CH - 6;
    const leader = dots(labelEnd, amountStart, itemSize);
    const color = STAMP_COLOR[line.verdict];
    const rot = stampRotation(line.label);
    const cx = PW - PAD - stampW / 2;
    const cy = y - 5;
    pieces.push({
      svg:
        mono(label, PAD, y, itemSize) +
        mono(leader, labelEnd, y, itemSize, { fill: "#B9B2A4" }) +
        mono(amount, amountRight, y, itemSize, {
          anchor: "end",
          fill: line.monthly_cents === null ? KEEP : INK,
        }) +
        `<g transform="rotate(${rot.toFixed(1)} ${cx} ${cy})" opacity="0.9">` +
        `<rect x="${cx - stampW / 2}" y="${cy - stampH / 2}" width="${stampW}" height="${stampH}" fill="none" stroke="${color}" stroke-width="2"/>` +
        `<text x="${cx}" y="${cy + 5}" font-family="JetBrains Mono" font-size="14" font-weight="700" fill="${color}" text-anchor="middle" letter-spacing="0.08em">${line.verdict}</text>` +
        `</g>`,
      h: 0,
    });
  }
  if (m.more_count > 0) {
    y += 26;
    const label = `+ ${m.more_count} MORE`;
    const amount = moneyLine(m.more_cents);
    const labelEnd = PAD + label.length * itemSize * MONO_CH + 6;
    const amountStart = amountRight - amount.length * itemSize * MONO_CH - 6;
    pieces.push({
      svg:
        mono(label, PAD, y, itemSize, { fill: KEEP }) +
        mono(dots(labelEnd, amountStart, itemSize), labelEnd, y, itemSize, { fill: "#B9B2A4" }) +
        mono(amount, amountRight, y, itemSize, { anchor: "end", fill: KEEP }),
      h: 0,
    });
  }

  y += 18;
  pieces.push({ svg: rule(y), h: 0 });

  // Totals
  y += 30;
  pieces.push({
    svg:
      mono("MONTHLY BILL", PAD, y, 17, { weight: 700 }) +
      mono(`${formatUSD(m.bill_cents)}/mo`, PW - PAD, y, 17, { weight: 700, anchor: "end" }),
    h: 0,
  });
  y += 40;
  const heroLabel = m.mode === "prospect" ? "ZO CAN PREVENT" : "ZO CAN KILL";
  pieces.push({
    svg:
      mono(heroLabel, PAD, y, 22, { weight: 700, fill: KILL }) +
      mono(`${formatUSD(m.hero_cents)}/mo`, PW - PAD, y, 26, { weight: 700, anchor: "end", fill: KILL }),
    h: 0,
  });
  y += 28;
  pieces.push({
    svg: mono(`THAT IS ${formatUSD(m.hero_cents * 12)}/YR`, PW - PAD, y, 15, { anchor: "end" }),
    h: 0,
  });

  // Counts
  y += 32;
  const countBits: string[] = [];
  for (const v of ["KILL", "TRIM", "KEEP", "SKIP"] as Verdict[]) {
    if (m.counts[v] > 0) countBits.push(`${m.counts[v]} ${v}`);
  }
  pieces.push({
    svg: mono(countBits.join(" · "), PW / 2, y, 13, { anchor: "middle", spacing: "0.1em", fill: KEEP }),
    h: 0,
  });
  if (m.overruled > 0) {
    y += 20;
    pieces.push({
      svg: mono(`* ${m.overruled} VERDICT${m.overruled > 1 ? "S" : ""} OVERRULED BY THE HUMAN`, PW / 2, y, 11, {
        anchor: "middle",
        fill: KEEP,
      }),
      h: 0,
    });
  }

  // Barcode
  y += 26;
  const bw = barcodeWidth(m.id);
  const bx = (PW - bw) / 2;
  const bars = barcodeBars(m.id)
    .map((b) => `<rect x="${(bx + b.x).toFixed(1)}" y="${y}" width="${b.w}" height="52" fill="${INK}"/>`)
    .join("");
  pieces.push({ svg: bars, h: 0 });
  y += 68;
  pieces.push({ svg: mono(m.id, PW / 2, y, 11, { anchor: "middle", spacing: "0.2em", fill: KEEP }), h: 0 });

  // Footer
  y += 28;
  pieces.push({
    svg: mono(m.host.toUpperCase(), PW / 2, y, 12, { anchor: "middle", spacing: "0.12em" }),
    h: 0,
  });
  y += 40;

  const paperH = y;
  const body = pieces.map((p) => p.svg).join("\n");

  // Torn bottom edge: deterministic zigzag seeded by the receipt id.
  const seed = fnv1a(m.id);
  const teeth: string[] = [`M 0 ${paperH}`];
  for (let tx = 0, i = 0; tx <= PW; tx += 26, i++) {
    const jag = ((seed >> (i % 24)) & 7) + 2;
    teeth.push(`L ${tx} ${paperH - jag}`);
    teeth.push(`L ${Math.min(tx + 13, PW)} ${paperH}`);
  }
  teeth.push(`L ${PW} ${paperH + 30} L 0 ${paperH + 30} Z`);

  // Perforated top: matte scallops eating into the paper edge, 12px pitch.
  const scallops: string[] = [];
  for (let sx = 6; sx < PW; sx += 12) {
    scallops.push(`<circle cx="${sx}" cy="0" r="3.5" fill="${INK}"/>`);
  }

  const { width, height } = canvas;
  const margin = Math.round(Math.min(width, height) * 0.055);
  const scale = Math.min((width - margin * 2) / PW, (height - margin * 2) / paperH, 1.15);
  const ox = (width - PW * scale) / 2;
  const oy = (height - paperH * scale) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.10 0 0 0 0 0.09 0 0 0 0 0.08 0 0 0 0.05 0"/>
  </filter>
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${PAPER}" stop-opacity="0"/>
    <stop offset="1" stop-color="#E8E2D2" stop-opacity="0.9"/>
  </linearGradient>
</defs>
<rect width="${width}" height="${height}" fill="${INK}"/>
<g transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)}) scale(${scale.toFixed(4)})">
  <rect x="6" y="8" width="${PW}" height="${paperH}" fill="rgba(0,0,0,0.45)"/>
  <rect x="0" y="0" width="${PW}" height="${paperH}" fill="${PAPER}"/>
  <rect x="0" y="${paperH - 46}" width="${PW}" height="46" fill="url(#fade)"/>
  ${body}
  <rect x="0" y="0" width="${PW}" height="${paperH}" fill="${PAPER}" opacity="0" />
  <rect x="0" y="0" width="${PW}" height="${paperH}" filter="url(#grain)"/>
  ${scallops.join("")}
  <path d="${teeth.join(" ")}" fill="${INK}"/>
</g>
</svg>`;
}

// The Wall payload: exactly the fields the PNG shows, nothing else.
export interface WallPayload {
  id: string;
  date: string;
  mode: "kill" | "prospect";
  lines: { label: string; monthly_cents: number | null; verdict: Verdict }[];
  more_count: number;
  more_cents: number;
  bill_cents: number;
  hero_cents: number;
  counts: Record<Verdict, number>;
  overruled: number;
}

export function wallPayload(m: ReceiptModel): WallPayload {
  if (!m.sanitized) throw new Error("wall payloads must come from a sanitized model");
  return {
    id: m.id,
    date: m.date,
    mode: m.mode,
    lines: m.lines.map((l) => ({ label: l.label, monthly_cents: l.monthly_cents, verdict: l.verdict })),
    more_count: m.more_count,
    more_cents: m.more_cents,
    bill_cents: m.bill_cents,
    hero_cents: m.hero_cents,
    counts: m.counts,
    overruled: m.overruled,
  };
}
