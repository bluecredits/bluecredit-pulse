/* BlueCredit Pulse — shared core for every app in the workspace (landing page, Business Review, Tickets).
   One Supabase project and one set of accounts: signing in on the landing page signs you in everywhere,
   because all apps live on the same site. No build step. */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CFG = window.PULSE_CONFIG || {};
const S = { user: null, profile: null, team: [] };
const today = () => new Date().toLocaleDateString("en-CA");
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const daysUntil = (iso) => Math.round((new Date(iso + "T12:00:00") - new Date(today() + "T12:00:00")) / 864e5);
const money = (n) => n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const short = (iso) => iso ? new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: String(iso).slice(0, 4) === today().slice(0, 4) ? undefined : "numeric" }) : "";
const ago = (ts) => { const m = Math.round((Date.now() - new Date(ts)) / 6e4); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const firstName = () => (S.profile?.display_name || "").split(" ")[0];
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600); }

const sb = CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

function must({ data, error, count }) {
  if (error) {
    if (/JWT|not authenticated|401/i.test(error.message)) authLost();
    throw new Error(error.message || "Something went wrong");
  }
  return count === undefined || count === null ? data : { data, count };
}
const db = { async rpc(fn, args) { return must(await sb.rpc(fn, args)); } };

/* ---------------- shared sign-in guard: apps send people to the landing page to sign in */
const HUB = window.PULSE_HUB || "../";
function authLost() { if (window.onAuthLost) return window.onAuthLost(); goSignIn(); }
function goSignIn() {
  const here = location.pathname.replace(/\/index\.html$/, "/").replace(/\/$/, "").split("/").pop();
  location.href = HUB + "?next=" + encodeURIComponent(here) + (/^#\//.test(location.hash) ? location.hash : "");
}
// Signed in and on the team? Returns {user, profile}; otherwise sends the visitor to sign in.
async function requireMember() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { goSignIn(); return null; }
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { goSignIn(); return null; }
  const prof = must(await sb.from("profiles").select("*").eq("id", user.id).maybeSingle());
  if (!prof || !prof.active) { goSignIn(); return null; }
  S.user = user; S.profile = prof;
  if (!S.team.length) S.team = must(await sb.from("profiles").select("*").order("display_name"));
  return { user, profile: prof };
}
function setWho(name) {
  $$("#whoami").forEach((e) => (e.textContent = name));
  $$("#avatar").forEach((e) => (e.textContent = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()));
}
function showShell() {
  $("#shell").hidden = false; $("#topbar").hidden = false;
  if (S.profile) setWho(S.profile.display_name);
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-signout]")) return;
  await sb.auth.signOut(); location.href = HUB;
});
document.addEventListener("click", (e) => {
  if (e.target.closest("#menuBtn")) document.body.classList.toggle("nav-open");
  else if (e.target.closest("#scrim")) document.body.classList.remove("nav-open");
});

/* ---------------- shared UI helpers */
function statusClass(v) {
  const s = (v || "").toLowerCase();
  if (["won", "done", "active", "responded", "meeting set", "approved", "available"].includes(s)) return "s-won";
  if (["lost", "missed", "dropped", "withdrawn", "cancelled", "do not contact", "rejected", "retired"].includes(s)) return "s-lost";
  if (["submitted", "in progress"].includes(s)) return "s-submitted";
  if (["pending approval", "in repair"].includes(s)) return "s-high";
  if (["identified", "qualifying", "pursuing", "open", "to contact", "contacted", "in use"].includes(s)) return "s-active";
  return "";
}
const pill = (v) => v ? `<span class="pill ${statusClass(v)}">${esc(v)}</span>` : "";
function dueCell(iso, active = true) {
  if (!iso) return "";
  const d = daysUntil(iso);
  const cls = !active ? "" : d < 0 ? "due-over" : d <= 7 ? "due-soon" : "";
  const hint = !active ? "" : d === 0 ? " · today" : d < 0 ? "" : d <= 14 ? ` · ${d}d` : "";
  return `<span class="${cls}" title="${iso}">${short(iso)}${hint}</span>`;
}
function downloadCsv(name, cols, rows) {
  const q = (v) => { v = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const text = [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv" })), download: name });
  document.body.appendChild(a); a.click(); a.remove();
}
function parseCsv(text) {
  const rows = []; let row = [], f = "", i = 0, quoted = false;
  text = text.replace(/^\ufeff/, "");
  while (i < text.length) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else quoted = false; } else f += c; }
    else if (c === '"') quoted = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
    i++;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}
async function readSheetFile(file) {
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "txt") return { sheets: [{ name: file.name, rows: parseCsv(await file.text()) }] };
  if (ext === "tsv") return { sheets: [{ name: file.name, rows: (await file.text()).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split("\t")) }] };
  if (ext !== "xlsx") throw new Error("Use an .xlsx, .csv or .tsv file. For an older .xls file, open it in Excel and save as .xlsx first.");
  return readXlsx(await file.arrayBuffer());
}
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), files = {};
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This doesn't look like a valid .xlsx file.");
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0, count = dv.getUint16(eocd + 10, true); n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const nameLen = dv.getUint16(p + 28, true);
    files[new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen))] =
      { method: dv.getUint16(p + 10, true), size: dv.getUint32(p + 20, true), local: dv.getUint32(p + 42, true) };
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return async (name) => {
    const f = files[name]; if (!f) return null;
    const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
    const data = u8.subarray(start, start + f.size);
    if (f.method === 0) return new TextDecoder().decode(data);
    if (f.method !== 8) throw new Error("This .xlsx uses an unsupported compression. Re-save it in Excel and try again.");
    return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
  };
}
async function readXlsx(buf) {
  const read = await unzip(buf);
  const xml = async (path) => { const t = await read(path); return t ? new DOMParser().parseFromString(t, "application/xml") : null; };
  const tags = (doc, name) => [...doc.getElementsByTagNameNS("*", name)];
  const text = (el) => tags(el, "t").map((t) => t.textContent).join("");
  const ss = await xml("xl/sharedStrings.xml");
  const shared = ss ? tags(ss, "si").map(text) : [];
  const wb = await xml("xl/workbook.xml"), rels = await xml("xl/_rels/workbook.xml.rels");
  if (!wb) throw new Error("This doesn't look like a valid .xlsx file.");
  const target = Object.fromEntries((rels ? tags(rels, "Relationship") : []).map((r) => [r.getAttribute("Id"), r.getAttribute("Target")]));
  const sheets = [];
  for (const [i, sh] of tags(wb, "sheet").entries()) {
    const rid = sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sh.getAttribute("r:id");
    let path = target[rid] || `worksheets/sheet${i + 1}.xml`;
    path = path.startsWith("/") ? path.slice(1) : "xl/" + path.replace(/^\.\//, "");
    const doc = await xml(path); if (!doc) continue;
    const rows = [];
    for (const row of tags(doc, "row")) {
      const out = [];
      for (const c of tags(row, "c")) {
        const ref = c.getAttribute("r") || "", col = ref ? [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : out.length;
        const t = c.getAttribute("t"), v = tags(c, "v")[0]?.textContent ?? "";
        let val = t === "s" ? shared[+v] ?? "" : t === "inlineStr" ? text(c) : t === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
        if (!t && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(val) && Number.isInteger(+val) && Math.abs(+val) < 1e15) val = String(+val);
        out[col] = val;
      }
      rows.push(Array.from(out, (x) => x ?? ""));
    }
    sheets.push({ name: sh.getAttribute("name") || `Sheet ${i + 1}`, rows });
  }
  if (!sheets.length) throw new Error("No sheets found in this file.");
  return { sheets };
}
function guessField(header) {
  const h = String(header).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!h) return "ignore";
  if (/linkedin/.test(h)) return "linkedin";
  if (/e ?mail/.test(h)) return "email";
  if (/phone|mobile|cell|telephone|^tel\b/.test(h)) return "phone";
  if (/^(first|given|fname)( name)?$/.test(h)) return "first";
  if (/^(last|surname|family|lname)( name)?$/.test(h)) return "last";
  if (/^(full name|name|contact|contact name|participant|attendee|attendee name|person|poc|point of contact|representative|registrant)$/.test(h)) return "name";
  if (/company|organi[sz]ation|^org$|firm|business name|employer|agency|vendor|account name|legal business name|^partner$/.test(h)) return "organization";
  if (/^(title|job title|role|position|designation)$/.test(h)) return "role";
  if (/^(city|town)$/.test(h)) return "city";
  if (/^(state|province|state province)$/.test(h)) return "state";
  if (/zip|postal/.test(h)) return "zip";
  if (/^country$/.test(h)) return "country";
  if (/^(location|address|street|street address|mailing address)$/.test(h)) return "location";
  return "notes";
}
function findHeaderRow(rows) {
  let best = 0, bestScore = -1;
  rows.slice(0, 15).forEach((r, i) => {
    const filled = r.filter((x) => String(x).trim()).length;
    const score = r.filter((x) => !["notes", "ignore"].includes(guessField(x))).length * 10 + Math.min(filled, 9);
    if (filled >= 2 && score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}
const tidy = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
function openDrawer() { const d = $("#drawer"); d.classList.add("open"); d.setAttribute("aria-hidden", "false"); }
function closeDrawer() { const d = $("#drawer"); d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); }
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
