// Kill List cockpit. Deployed private on the user's own Zo (SKILL.md stage 4)
// at /kill-cockpit. Talks only to /api/kill-cockpit on the same origin, with
// the capability token carried in the link. Nothing here posts anywhere; the
// one outbound action (Print to the Wall) is explicit and server-mediated.
import { useCallback, useEffect, useMemo, useState } from "react";

const API = "/api/kill-cockpit";

const INK = "#14120F";
const SURFACE = "#1E1B17";
const TEXT = "#EDE8DC";
const MUTED = "#8F887C";
const PAPER = "#F7F4EC";
const KILL = "#C8102E";
const KEEP = "#6B6660";
const TRIM = "#B7791F";
const SAVED = "#1F7A4D";

interface Row {
  merchant: string;
  amount: number | null;
  cadence: string;
  monthly_equivalent: number | null;
  charge_count: number;
  status: string;
  confidence: string;
  source_msg_ids: string[];
  category: string;
  user_state: "pending" | "confirmed" | "excluded" | "private";
  verdict: "KILL" | "KEEP" | "TRIM" | "SKIP" | null;
  verdict_reason: string | null;
  verdict_overruled: boolean;
  included_in_receipt: boolean;
  _key: string;
}

interface CatalogEntry {
  slug: string;
  name: string;
  typical_price_monthly: number;
  verdict: string;
  verdict_reason: string;
  what_zo_builds: string;
  hours_to_build: number;
  annual_savings: number;
  dont_kill_if: string;
  build_brief: string;
  _keys: string[];
}

interface State {
  ledger: { meta: Record<string, unknown>; subscriptions: Row[] } | null;
  wall: Record<string, unknown> | null;
  has_session: boolean;
  has_receipt: boolean;
}

function usd(n: number | null): string {
  if (n === null) return "UNVERIFIED";
  return `$${n.toFixed(2)}`;
}

function hashAngle(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return -4 + (h % 71) / 10;
}

const VERDICT_COLOR: Record<string, string> = { KILL, KEEP, TRIM, SKIP: KEEP };

export default function Cockpit() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get("t") ?? "", []);
  const [data, setData] = useState<State | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [tab, setTab] = useState<"review" | "verdicts" | "receipt">("review");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [rebuilt, setRebuilt] = useState(false);
  const [imgVer, setImgVer] = useState(0);
  const [overruleFor, setOverruleFor] = useState<string | null>(null);
  const [sanitized, setSanitized] = useState(true);
  const [size, setSize] = useState("1080x1350");
  const [add, setAdd] = useState({ merchant: "", amount: "", cadence: "monthly" });

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch(`${API}?t=${encodeURIComponent(token)}&a=state`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    setData(json as State);
  }, [token]);

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message ?? e)));
    fetch(`${API}?t=${encodeURIComponent(token)}&a=catalog`)
      .then((r) => r.json())
      .then((j) => setCatalog(j.catalog ?? []))
      .catch(() => {});
  }, [refresh, token]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setErr(null);
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ t: token, ...body }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (json.ledger !== undefined) setData(json as State);
        return json;
      } catch (e) {
        setErr(String((e as Error).message ?? e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  const rows = data?.ledger?.subscriptions ?? [];
  const visible = rows.filter((r) => r.user_state !== "private");
  const privateCount = rows.length - visible.length;
  const confirmed = rows.filter((r) => r.user_state === "confirmed");
  const pendingCount = rows.filter((r) => r.user_state === "pending").length;
  const confirmedTotal = confirmed.reduce((t, r) => t + (r.monthly_equivalent ?? 0), 0);
  const overruledCount = rows.filter((r) => r.verdict_overruled).length;
  const briefFor = (row: Row) => catalog.find((e) => e._keys.includes(row._key));

  const setState = (row: Row, user_state: Row["user_state"]) =>
    post({ a: "row", key: row._key, patch: { user_state } });

  if (err && !data) {
    return (
      <div style={{ background: INK, color: TEXT, minHeight: "100vh", padding: 40, fontFamily: "monospace" }}>
        <p>COCKPIT LOCKED: {err}</p>
        <p style={{ color: MUTED }}>Open the exact link your Zo handed you in chat; the token is part of it.</p>
      </div>
    );
  }

  return (
    <div className="kc">
      <style>{css}</style>
      <header>
        <div>
          <h1>THE KILL LIST</h1>
          <span className="sub">COCKPIT · PRIVATE · THIS ZO ONLY</span>
        </div>
        <nav>
          {(["review", "verdicts", "receipt"] as const).map((t) => (
            <button key={t} className={tab === t ? "tab on" : "tab"} onClick={() => setTab(t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </nav>
      </header>

      {err && <div className="err">{err}</div>}
      {toast && <div className="toast">{toast}</div>}
      {!data && <p className="dim">Loading the ledger…</p>}

      {data && !data.ledger && (
        <p className="dim">No ledger yet. Run the scan stages in your Zo chat first (SKILL.md stages 2 and 3).</p>
      )}

      {data?.ledger && tab === "review" && (
        <section>
          {pendingCount > 0 && (
            <div className="gate">
              {pendingCount} row{pendingCount === 1 ? "" : "s"} still pending. Decide every row before verdicts:
              confirm it, exclude it, or mark it private.
            </div>
          )}
          {visible.map((r) => (
            <article key={r._key} className={`row ${r.user_state}`}>
              <div className="rowmain">
                <div>
                  <strong>{r.merchant}</strong>
                  <span className={`chip ${r.confidence}`}>
                    {r.confidence.toUpperCase()}
                    {r.amount === null ? " · UNVERIFIED" : ""}
                  </span>
                </div>
                <span className="price">
                  {r.monthly_equivalent !== null ? `${usd(r.monthly_equivalent)}/mo` : usd(r.amount)}
                </span>
              </div>
              <div className="rowmeta">
                {r.cadence} · {r.status} · {r.source_msg_ids.length || "no"} email
                {r.source_msg_ids.length === 1 ? "" : "s"}
                {r.charge_count ? ` · ${r.charge_count} charges` : ""}
              </div>
              <div className="rowact">
                {(["confirmed", "excluded", "private"] as const).map((s) => (
                  <button
                    key={s}
                    disabled={busy}
                    className={r.user_state === s ? "act on" : "act"}
                    onClick={() => setState(r, s)}
                  >
                    {{ confirmed: "CONFIRM", excluded: "EXCLUDE", private: "PRIVATE" }[s]}
                  </button>
                ))}
                <input
                  className="cat"
                  defaultValue={r.category}
                  placeholder="category"
                  onBlur={(e) => {
                    if (e.target.value !== r.category) post({ a: "row", key: r._key, patch: { category: e.target.value } });
                  }}
                />
              </div>
            </article>
          ))}
          {privateCount > 0 && (
            <div className="ghost">
              {privateCount} row{privateCount === 1 ? "" : "s"} marked private. Private rows never reach any receipt
              surface, period.
            </div>
          )}
          <form
            className="addrow"
            onSubmit={(e) => {
              e.preventDefault();
              if (!add.merchant) return;
              post({ a: "add", merchant: add.merchant, amount: add.amount, cadence: add.cadence }).then((r) => {
                if (r) setAdd({ merchant: "", amount: "", cadence: "monthly" });
              });
            }}
          >
            <span className="dim">Bill with no email trail?</span>
            <input value={add.merchant} placeholder="merchant" onChange={(e) => setAdd({ ...add, merchant: e.target.value })} />
            <input value={add.amount} placeholder="$0.00" onChange={(e) => setAdd({ ...add, amount: e.target.value })} />
            <select value={add.cadence} onChange={(e) => setAdd({ ...add, cadence: e.target.value })}>
              {["monthly", "annual", "quarterly", "weekly", "unknown"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <button className="act" disabled={busy}>
              ADD
            </button>
          </form>
          <footer className="totals">
            <span>
              CONFIRMED {confirmed.length} ROW{confirmed.length === 1 ? "" : "S"}
            </span>
            <span className="price">{usd(confirmedTotal)}/mo</span>
          </footer>
        </section>
      )}

      {data?.ledger && tab === "verdicts" && (
        <section>
          {confirmed.length === 0 && <p className="dim">Nothing confirmed yet. The review tab gates this one.</p>}
          {confirmed.map((r, i) => {
            const brief = briefFor(r);
            return (
              <article key={r._key} className="row">
                <div className="rowmain">
                  <div>
                    <strong>{r.merchant}</strong>
                    {r.verdict_overruled && <span className="star">*</span>}
                  </div>
                  <span className="stampwrap">
                    <span className="price">{r.monthly_equivalent !== null ? `${usd(r.monthly_equivalent)}/mo` : "UNVERIFIED"}</span>
                    <button
                      className="stamp"
                      title="Click to overrule"
                      style={{
                        color: VERDICT_COLOR[r.verdict ?? ""] ?? MUTED,
                        borderColor: VERDICT_COLOR[r.verdict ?? ""] ?? MUTED,
                        transform: `rotate(${hashAngle(r.merchant)}deg)`,
                        animationDelay: `${i * 90}ms`,
                      }}
                      onClick={() => setOverruleFor(overruleFor === r._key ? null : r._key)}
                    >
                      {r.verdict ?? "----"}
                    </button>
                  </span>
                </div>
                <div className="rowmeta">{r.verdict_reason ?? "awaiting judgment: rebuild to stamp"}</div>
                {overruleFor === r._key && (
                  <Overrule row={r} busy={busy} onSave={(patch) => post({ a: "row", key: r._key, patch }).then(() => setOverruleFor(null))} />
                )}
                {brief && (r.verdict === "KILL" || r.verdict === "TRIM") && (
                  <details className="brief">
                    <summary>BUILD BRIEF · {brief.hours_to_build}h · saves ~${brief.annual_savings}/yr</summary>
                    <p>{brief.what_zo_builds}</p>
                    <p className="dontkill">DON'T KILL IF: {brief.dont_kill_if}</p>
                    <button
                      className="act"
                      onClick={() => navigator.clipboard.writeText(brief.build_brief).then(() => say("Copied. Go kill it."))}
                    >
                      COPY BRIEF
                    </button>
                  </details>
                )}
              </article>
            );
          })}
          <footer className="totals">
            <span>
              {overruledCount === 0
                ? "NO VERDICTS OVERRULED"
                : `${overruledCount} VERDICT${overruledCount === 1 ? "" : "S"} OVERRULED BY THE HUMAN*`}
            </span>
            <button className="act" disabled={busy} onClick={() => post({ a: "rebuild" }).then((r) => r && setLog(r.log))}>
              RESTAMP + RENDER
            </button>
          </footer>
        </section>
      )}

      {data?.ledger && tab === "receipt" && (
        <section className="split">
          <div className="controls">
            <h2>WHAT PRINTS</h2>
            {confirmed.map((r) => (
              <label key={r._key} className="inc">
                <input
                  type="checkbox"
                  checked={r.included_in_receipt}
                  disabled={busy}
                  onChange={(e) => post({ a: "row", key: r._key, patch: { included_in_receipt: e.target.checked } })}
                />
                <span>{r.merchant}</span>
                <span className="price">{r.monthly_equivalent !== null ? usd(r.monthly_equivalent) : "UNVERIFIED"}</span>
              </label>
            ))}
            <h2>PRIVACY</h2>
            <label className="inc">
              <input type="checkbox" checked={sanitized} onChange={(e) => setSanitized(e.target.checked)} />
              <span>Sanitize preview: hide merchant names, round to dollars</span>
            </label>
            <p className="dim">The Wall only ever accepts the sanitized version, whatever you preview here.</p>
            <h2>SIZE</h2>
            {["1080x1350", "1600x900"].map((s) => (
              <label key={s} className="inc">
                <input type="radio" name="size" checked={size === s} onChange={() => setSize(s)} /> <span>{s}</span>
              </label>
            ))}
            <button
              className="act big"
              disabled={busy}
              onClick={() =>
                post({ a: "rebuild" }).then((r) => {
                  if (r) {
                    setLog(r.log);
                    setRebuilt(true);
                    setImgVer((v) => v + 1);
                    say("Receipt rendered.");
                  }
                })
              }
            >
              {busy ? "RENDERING…" : "RENDER RECEIPT"}
            </button>
            {log && <pre className="log">{log}</pre>}
            <h2>THE WALL</h2>
            {data.wall && <pre className="log">{JSON.stringify(data.wall, null, 1)}</pre>}
            <button
              className="wall"
              disabled={busy || !data.has_receipt || !data.has_session}
              onClick={() => {
                if (window.confirm("Push the sanitized receipt above to the public Wall queue?")) {
                  post({ a: "wall" }).then((r) => r && say("Sent. It waits in the approval queue."));
                }
              }}
            >
              PRINT TO THE WALL
            </button>
            <p className="dim">
              Explicit, separate, never default. Sends the sanitized JSON above and nothing else.
              {!data.has_session && " (No session.json on this machine, so the button stays dark.)"}
              <br />
              Nothing posts automatically.
            </p>
          </div>
          <div className="preview">
            {data.has_receipt ? (
              <div className="paperwrap">
                <img
                  alt="receipt preview"
                  src={`${API}?t=${encodeURIComponent(token)}&a=png&f=receipt${sanitized ? "-sanitized" : ""}-${size}.png&v=${imgVer}`}
                />
                {!rebuilt && <span className="draft">DRAFT</span>}
              </div>
            ) : (
              <p className="dim">No render yet. RENDER RECEIPT writes PNGs to out/receipt/ on this machine.</p>
            )}
            {data.has_receipt && (
              <p className="dim path">
                out/receipt/receipt{sanitized ? "-sanitized" : ""}-{size}.png
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Overrule({
  row,
  busy,
  onSave,
}: {
  row: Row;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [verdict, setVerdict] = useState<string>(row.verdict && row.verdict !== "SKIP" ? row.verdict : "KEEP");
  const [reason, setReason] = useState(row.verdict_overruled ? (row.verdict_reason ?? "") : "");
  return (
    <div className="overrule">
      {["KILL", "KEEP", "TRIM"].map((v) => (
        <button
          key={v}
          className={verdict === v ? "act on" : "act"}
          style={{ color: VERDICT_COLOR[v] }}
          onClick={() => setVerdict(v)}
        >
          {v}
        </button>
      ))}
      <input value={reason} maxLength={140} placeholder="your reason (required, it prints)" onChange={(e) => setReason(e.target.value)} />
      <button className="act" disabled={busy || !reason} onClick={() => onSave({ overrule: { verdict, reason } })}>
        OVERRULE
      </button>
      {row.verdict_overruled && (
        <button className="act" disabled={busy} onClick={() => onSave({ overrule: null })}>
          LET THE MACHINE DECIDE
        </button>
      )}
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@500;700&display=swap');
.kc { background:${INK}; color:${TEXT}; min-height:100vh; font-family:'JetBrains Mono',monospace; font-size:14px; padding:24px; max-width:1100px; margin:0 auto; }
.kc header { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2px solid ${SURFACE}; padding-bottom:16px; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
.kc h1 { font-family:'Space Grotesk',sans-serif; font-weight:700; letter-spacing:.18em; margin:0; font-size:22px; }
.kc h2 { font-size:12px; letter-spacing:.15em; color:${MUTED}; margin:18px 0 8px; }
.kc .sub { color:${MUTED}; font-size:11px; letter-spacing:.12em; }
.kc .tab { background:none; border:none; color:${MUTED}; font:inherit; letter-spacing:.12em; padding:8px 14px; cursor:pointer; border-bottom:2px solid transparent; }
.kc .tab.on { color:${TEXT}; border-bottom-color:${KILL}; }
.kc .err { background:${KILL}; color:${PAPER}; padding:10px 14px; margin-bottom:14px; }
.kc .toast { position:fixed; bottom:24px; right:24px; background:${SAVED}; color:${PAPER}; padding:10px 16px; z-index:9; }
.kc .dim { color:${MUTED}; }
.kc .gate { border:1px solid ${TRIM}; color:${TRIM}; padding:10px 14px; margin-bottom:14px; }
.kc .row { background:${SURFACE}; padding:14px 16px; margin-bottom:10px; }
.kc .row.excluded { opacity:.45; }
.kc .rowmain { display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
.kc .rowmain strong { font-family:'Space Grotesk',sans-serif; font-size:16px; letter-spacing:.02em; }
.kc .rowmeta { color:${MUTED}; font-size:12px; margin-top:4px; }
.kc .rowact { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center; }
.kc .price { font-variant-numeric:tabular-nums; }
.kc .chip { font-size:10px; letter-spacing:.1em; border:1px solid ${MUTED}; color:${MUTED}; padding:2px 6px; margin-left:10px; vertical-align:2px; }
.kc .chip.medium { border-color:${TRIM}; color:${TRIM}; }
.kc .chip.low { border-color:${KILL}; color:${KILL}; }
.kc .act { background:none; border:1px solid ${MUTED}; color:${TEXT}; font:inherit; font-size:11px; letter-spacing:.1em; padding:6px 10px; cursor:pointer; }
.kc .act.on { border-color:${TEXT}; background:${TEXT}; color:${INK}; }
.kc .act.big { display:block; width:100%; margin-top:16px; padding:14px; font-size:13px; border-width:2px; }
.kc .act:disabled { opacity:.4; cursor:default; }
.kc input, .kc select { background:${INK}; border:1px solid ${MUTED}; color:${TEXT}; font:inherit; font-size:12px; padding:6px 8px; }
.kc .cat { width:130px; }
.kc .ghost { border:1px dashed ${MUTED}; color:${MUTED}; padding:10px 14px; margin:14px 0; }
.kc .addrow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:18px 0; }
.kc .totals { position:sticky; bottom:0; background:${SURFACE}; border-top:2px solid ${KILL}; display:flex; justify-content:space-between; align-items:center; padding:12px 16px; letter-spacing:.08em; }
.kc .stampwrap { display:flex; gap:14px; align-items:center; }
.kc .stamp { font:inherit; font-weight:700; letter-spacing:.14em; background:none; border:2px solid; padding:4px 10px; cursor:pointer; animation:kcland .18s ease-out backwards; }
@keyframes kcland { from { transform:scale(1.6); opacity:0; } }
.kc .star { color:${TRIM}; margin-left:6px; font-weight:700; }
.kc .overrule { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center; }
.kc .overrule input { flex:1; min-width:180px; }
.kc .brief { margin-top:10px; border-top:1px dashed ${MUTED}; padding-top:10px; }
.kc .brief summary { cursor:pointer; letter-spacing:.08em; color:${SAVED}; }
.kc .brief .dontkill { color:${TRIM}; }
.kc .split { display:flex; gap:24px; align-items:flex-start; flex-wrap:wrap; }
.kc .controls { flex:1; min-width:300px; }
.kc .inc { display:flex; gap:10px; align-items:center; padding:6px 0; }
.kc .inc .price { margin-left:auto; }
.kc .log { background:${SURFACE}; color:${MUTED}; font-size:11px; padding:10px; overflow:auto; max-height:180px; white-space:pre-wrap; }
.kc .wall { display:block; width:100%; margin-top:8px; background:${KILL}; color:${PAPER}; border:2px solid ${INK}; box-shadow:4px 4px 0 ${SURFACE}; font-family:'Space Grotesk',sans-serif; font-weight:700; letter-spacing:.12em; font-size:14px; padding:14px; cursor:pointer; }
.kc .wall:active { transform:translate(2px,2px); box-shadow:2px 2px 0 ${SURFACE}; }
.kc .wall:disabled { opacity:.35; cursor:default; }
.kc .preview { flex:1.2; min-width:320px; }
.kc .paperwrap { position:relative; background:${SURFACE}; padding:20px; }
.kc .paperwrap img { width:100%; display:block; }
.kc .draft { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%) rotate(-18deg); font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:64px; letter-spacing:.2em; color:${KILL}; opacity:.35; pointer-events:none; }
.kc .path { font-size:11px; word-break:break-all; }
`;
