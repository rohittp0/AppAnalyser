"use strict";

// ---------- state ----------
let INDEX = null;
let LOGS = null;
const CACHE = new Map(); // file path -> parsed JSON

// ---------- utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]
  ));
}

async function fetchJson(relPath) {
  if (CACHE.has(relPath)) return CACHE.get(relPath);
  const res = await fetch(`data/${relPath}`);
  if (!res.ok) throw new Error(`Failed to load data/${relPath}`);
  const json = await res.json();
  CACHE.set(relPath, json);
  return json;
}

function setActivePage(name) {
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  $$(".page").forEach(p => p.classList.toggle("active", p.id === `page-${name}`));
}

function activateChip(containerSel, chip) {
  $$(`${containerSel} .file-chip`).forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
}

// ---------- overview ----------
const ANDROID_RELEASES = {
  21: "5.0 Lollipop", 22: "5.1 Lollipop", 23: "6.0 Marshmallow",
  24: "7.0 Nougat", 25: "7.1 Nougat", 26: "8.0 Oreo", 27: "8.1 Oreo",
  28: "9 Pie", 29: "10", 30: "11", 31: "12", 32: "12L",
  33: "13", 34: "14", 35: "15", 36: "16",
};
const SDK_MIN = 21;
const SDK_MAX = 36;

async function renderOverview() {
  const page = $("#page-overview");
  const summary = INDEX.meta || {};
  if (!summary.present) {
    page.innerHTML = `
      <h2>Overview</h2>
      <div class="error-banner">No <code>meta.json</code> in export root — cannot show export identity.</div>`;
    return;
  }
  if (summary.error) {
    page.innerHTML = `
      <h2>Overview</h2>
      <div class="error-banner">meta.json parse error: ${escapeHtml(summary.error)}</div>`;
    return;
  }
  const meta = await fetchJson(summary.file);
  page.innerHTML = overviewHtml(meta);
  wireOverview(meta);
}

function overviewHtml(m) {
  const exportedAbs = fmtIso(m.exportedAt);
  const exportedRel = relativeTime(m.exportedAt);
  const buildBadge = m.debug
    ? `<span class="badge badge-warn">debug</span>`
    : `<span class="badge badge-ok">release</span>`;
  const buildType = m.buildType ? `<span class="pill code">${escapeHtml(m.buildType)}</span>` : "";
  const sdk = Number.isFinite(m.androidSdk) ? m.androidSdk : null;
  const release = m.androidRelease || (sdk != null ? ANDROID_RELEASES[sdk] : null) || "—";
  const abis = (m.supportedAbis || "").split(",").map(s => s.trim()).filter(Boolean);
  const deviceTitle = [m.model, m.manufacturer].filter(Boolean).join(" · ") || "—";
  const brandProduct = [m.brand, m.product].filter(Boolean).join(" / ") || "—";
  const locale = m.locale || "—";
  const tz = m.timezone || null;
  const tzOffset = tz ? formatTzOffset(tz) : "";
  const identity = [];
  if (m.deviceName) identity.push({ label: "device name", value: m.deviceName });
  if (m.deviceId) identity.push({ label: "device id", value: m.deviceId });

  return `
    <h2>Overview</h2>

    <div class="ov-hero">
      <div class="ov-hero-main">
        <div class="ov-hero-label">Application</div>
        <div class="ov-hero-app">${escapeHtml(m.applicationId || "—")}</div>
        <div class="ov-hero-version">
          <span class="ov-version-name">${escapeHtml(m.versionName || "—")}</span>
          <span class="ov-version-code">build ${escapeHtml(String(m.versionCode ?? "—"))}</span>
          ${buildType}
          ${buildBadge}
        </div>
      </div>
      <div class="ov-hero-side">
        <div class="ov-hero-label">Exported</div>
        <div class="ov-hero-when">${escapeHtml(exportedAbs)}</div>
        <div class="ov-hero-rel">${escapeHtml(exportedRel)}</div>
      </div>
    </div>

    <div class="ov-grid">
      <section class="ov-card ov-device">
        <div class="ov-card-label">Device</div>
        <div class="ov-device-name">${escapeHtml(deviceTitle)}</div>
        <div class="ov-device-sub">${escapeHtml(brandProduct)}</div>
        ${identity.length ? `
          <dl class="ov-dl">
            ${identity.map(r => `
              <dt>${escapeHtml(r.label)}</dt>
              <dd>${escapeHtml(r.value)}</dd>`).join("")}
          </dl>` : ""}
      </section>

      <section class="ov-card ov-android">
        <div class="ov-card-label">Android</div>
        <div class="ov-android-name">${escapeHtml(release)}</div>
        <div class="ov-android-api">API ${escapeHtml(String(sdk ?? "—"))}</div>
        ${sdk != null ? sdkScaleHtml(sdk) : ""}
      </section>

      <section class="ov-card ov-abis">
        <div class="ov-card-label">Supported ABIs</div>
        ${abis.length
          ? `<div class="ov-abi-list">${abis.map(a => `<span class="ov-abi">${escapeHtml(a)}</span>`).join("")}</div>`
          : `<div class="ov-empty">—</div>`}
      </section>

      <section class="ov-card ov-locale">
        <div class="ov-card-label">Locale &amp; Timezone</div>
        <div class="ov-locale-row">
          <span class="ov-locale-tag">${escapeHtml(locale)}</span>
          ${tz ? `<span class="ov-tz">${escapeHtml(tz)}<span class="ov-tz-off">${escapeHtml(tzOffset)}</span></span>` : ""}
        </div>
      </section>
    </div>

    <section class="ov-card ov-fp">
      <div class="ov-card-label">Build Fingerprint</div>
      <div class="ov-fp-row">
        <code class="ov-fp-val" id="ov-fp">${escapeHtml(m.fingerprint || "—")}</code>
        ${m.fingerprint ? `<button class="action" id="ov-fp-copy">Copy</button>` : ""}
      </div>
    </section>`;
}

function sdkScaleHtml(sdk) {
  const clamped = Math.max(SDK_MIN, Math.min(SDK_MAX, sdk));
  const pct = ((clamped - SDK_MIN) / (SDK_MAX - SDK_MIN)) * 100;
  return `
    <div class="ov-sdk-scale" role="img" aria-label="Android API ${sdk} of ${SDK_MIN}–${SDK_MAX}">
      <div class="ov-sdk-track"><div class="ov-sdk-fill" style="width: ${pct.toFixed(1)}%"></div></div>
      <div class="ov-sdk-marker" style="left: ${pct.toFixed(1)}%"><span>${sdk}</span></div>
      <div class="ov-sdk-ticks">
        <span>${SDK_MIN}</span><span>${SDK_MAX}</span>
      </div>
    </div>`;
}

function wireOverview(m) {
  const btn = $("#ov-fp-copy");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(m.fingerprint || "");
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 1200);
    } catch { /* ignore */ }
  });
}

function fmtIso(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return s;
  // Use ISO-like but space separator and drop millis/zone noise.
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function relativeTime(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const pick = (n, unit) => {
    const v = Math.round(n);
    const word = v === 1 ? unit : `${unit}s`;
    return future ? `in ${v} ${word}` : `${v} ${word} ago`;
  };
  if (abs < 45) return future ? "in moments" : "just now";
  if (abs < 3600) return pick(abs / 60, "minute");
  if (abs < 86400) return pick(abs / 3600, "hour");
  if (abs < 2592000) return pick(abs / 86400, "day");
  if (abs < 31536000) return pick(abs / 2592000, "month");
  return pick(abs / 31536000, "year");
}

function formatTzOffset(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: tz, timeZoneName: "longOffset",
    }).formatToParts(new Date());
    const off = parts.find(p => p.type === "timeZoneName");
    if (off) return off.value.replace(/^GMT/, "UTC");
  } catch { /* fall through */ }
  return "";
}

// ---------- databases ----------
async function renderDatabases() {
  const page = $("#page-databases");
  const dbs = INDEX.databases || [];
  if (dbs.length === 0) {
    page.innerHTML = `<h2>Databases</h2><p class="empty">No SQLite files found under databases/.</p>`;
    return;
  }
  page.innerHTML = `
    <h2>Databases</h2>
    <div class="file-list" id="db-list">
      ${dbs.map(d => `<div class="file-chip" data-file="${d.file}">${escapeHtml(d.name)}<span class="pill">${d.tables.length} tables</span></div>`).join("")}
    </div>
    <div id="db-detail"></div>`;
  $$("#db-list .file-chip").forEach(chip => chip.addEventListener("click", () => openDatabase(chip)));
  openDatabase($("#db-list .file-chip"));
}

async function openDatabase(chip) {
  activateChip("#db-list", chip);
  const db = await fetchJson(chip.dataset.file);
  const detail = $("#db-detail");
  if (db.tables.length === 0) {
    detail.innerHTML = `<p class="empty">${escapeHtml(db.name)} contains no user tables.</p>`;
    return;
  }
  detail.innerHTML = `
    <h3>${escapeHtml(db.name)}</h3>
    <div class="file-list" id="tbl-list">
      ${db.tables.map(t => `<div class="file-chip" data-table="${escapeHtml(t.name)}">${escapeHtml(t.name)}<span class="pill">${t.rows.length}</span></div>`).join("")}
    </div>
    <div id="tbl-detail"></div>`;
  $$("#tbl-list .file-chip").forEach(c => c.addEventListener("click", () => showTable(db, c)));
  showTable(db, $("#tbl-list .file-chip"));
}

function showTable(db, chip) {
  activateChip("#tbl-list", chip);
  const t = db.tables.find(x => x.name === chip.dataset.table);
  $("#tbl-detail").innerHTML = `
    <div class="toolbar">
      <span class="pill">${t.rows.length} rows</span>
      <span class="pill">${t.columns.length} columns</span>
      <button class="action" id="csv-btn">Export CSV</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>${t.columns.map(colHeader).join("")}</tr></thead>
        <tbody>${t.rows.map(r => `<tr>${r.map(cellFmt).join("")}</tr>`).join("")}</tbody>
      </table>
    </div>`;
  $("#csv-btn").addEventListener("click", () => exportCsv(t));
}

function colHeader(c) {
  const bits = [c.type || "(no type)"];
  if (c.pk) bits.push("PK");
  if (c.notnull) bits.push("NOT NULL");
  return `<th title="${escapeHtml(bits.join(" · "))}">${escapeHtml(c.name)}</th>`;
}

function cellFmt(v) {
  if (v === null || v === undefined) return '<td><span class="pill">NULL</span></td>';
  if (typeof v === "boolean") return `<td>${v ? "true" : "false"}</td>`;
  return `<td>${escapeHtml(String(v))}</td>`;
}

function exportCsv(tbl) {
  const header = tbl.columns.map(c => csvCell(c.name)).join(",");
  const rows = tbl.rows.map(r => r.map(csvCell).join(","));
  const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
  triggerDownload(blob, `${tbl.name}.csv`);
}
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- datastore ----------
async function renderDataStore() {
  const page = $("#page-datastore");
  const items = INDEX.datastore || [];
  if (items.length === 0) {
    page.innerHTML = `<h2>DataStore</h2><p class="empty">No datastore/ files in export.</p>`;
    return;
  }
  page.innerHTML = `
    <h2>DataStore</h2>
    <div class="file-list" id="ds-list">
      ${items.map(d => `<div class="file-chip" data-file="${d.file}">${escapeHtml(d.name)}<span class="pill code">${escapeHtml(d.kind)}</span></div>`).join("")}
    </div>
    <div id="ds-detail"></div>`;
  $$("#ds-list .file-chip").forEach(c => c.addEventListener("click", () => openDataStore(c)));
  openDataStore($("#ds-list .file-chip"));
}

async function openDataStore(chip) {
  activateChip("#ds-list", chip);
  const data = await fetchJson(chip.dataset.file);
  const detail = $("#ds-detail");
  if (data.kind === "preferences") {
    renderKvTable(detail, data);
  } else if (data.kind === "error") {
    detail.innerHTML = `
      <h3>${escapeHtml(data.name)} <span class="pill code">error</span></h3>
      <div class="error-banner">Parse error: ${escapeHtml(data.error || "unknown")}</div>`;
  } else {
    renderJsonTree(detail, data);
  }
}

function renderJsonTree(target, data) {
  target.innerHTML = `
    <h3>${escapeHtml(data.name)} <span class="pill code">${escapeHtml(data.kind)}</span></h3>
    <div class="json-toolbar toolbar">
      <button class="action" data-act="expand">Expand all</button>
      <button class="action" data-act="collapse">Collapse all</button>
    </div>
    <div class="json-tree" id="json-root">${jsonNode(data.json, 0, true)}</div>`;
  target.querySelector('[data-act="expand"]').addEventListener("click", () =>
    $$("#json-root details").forEach(d => d.open = true));
  target.querySelector('[data-act="collapse"]').addEventListener("click", () =>
    $$("#json-root details").forEach(d => d.open = false));
}

function jsonNode(v, depth, root = false) {
  if (v === null) return `<span class="z">null</span>`;
  if (typeof v === "boolean") return `<span class="b">${v}</span>`;
  if (typeof v === "number") return `<span class="n">${v}</span>`;
  if (typeof v === "string") return `<span class="s">"${escapeHtml(v)}"</span>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `<span class="t">[]</span>`;
    const open = depth < 2 ? " open" : "";
    const inner = v.map((item, i) => {
      if (item !== null && typeof item === "object") {
        return `<div class="leaf"><span class="k">${i}</span><span class="t">: </span>${jsonNode(item, depth + 1)}</div>`;
      }
      return `<div class="leaf"><span class="k">${i}</span><span class="t">: </span>${jsonNode(item, depth + 1)}</div>`;
    }).join("");
    return `<details${open}><summary><span class="t">Array(${v.length})</span></summary>${inner}</details>`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 0) return `<span class="t">{}</span>`;
    const open = root || depth < 2 ? " open" : "";
    const label = root ? '<span class="t">root</span>' : `<span class="t">{${keys.length}}</span>`;
    const inner = keys.map(k => {
      const val = v[k];
      if (val !== null && typeof val === "object") {
        return `<div class="leaf"><span class="k">${escapeHtml(k)}</span><span class="t">: </span>${jsonNode(val, depth + 1)}</div>`;
      }
      return `<div class="leaf"><span class="k">${escapeHtml(k)}</span><span class="t">: </span>${jsonNode(val, depth + 1)}</div>`;
    }).join("");
    return `<details${open}><summary>${label}</summary>${inner}</details>`;
  }
  return `<span class="t">${escapeHtml(String(v))}</span>`;
}

// ---------- shared prefs ----------
async function renderSharedPrefs() {
  const page = $("#page-shared_prefs");
  const items = INDEX.shared_prefs || [];
  if (items.length === 0) {
    page.innerHTML = `<h2>Shared Prefs</h2><p class="empty">No shared_prefs/ files in export.</p>`;
    return;
  }
  page.innerHTML = `
    <h2>Shared Prefs</h2>
    <div class="file-list" id="sp-list">
      ${items.map(d => `<div class="file-chip" data-file="${d.file}">${escapeHtml(d.name)}<span class="pill">${d.entries}</span></div>`).join("")}
    </div>
    <div id="sp-detail"></div>`;
  $$("#sp-list .file-chip").forEach(c => c.addEventListener("click", () => openSharedPrefs(c)));
  openSharedPrefs($("#sp-list .file-chip"));
}

async function openSharedPrefs(chip) {
  activateChip("#sp-list", chip);
  const data = await fetchJson(chip.dataset.file);
  renderKvTable($("#sp-detail"), data);
}

function renderKvTable(target, data) {
  const entries = data.entries || [];
  target.innerHTML = `
    <h3>${escapeHtml(data.name)} <span class="pill">${entries.length} entries</span></h3>
    <div class="toolbar">
      <label>Filter <input type="search" id="kv-filter" placeholder="key or value substring"></label>
    </div>
    <div class="table-wrap">
      <table class="kv">
        <thead><tr>
          <th title="Preference key">Key</th>
          <th title="Data type">Type</th>
          <th title="Stored value">Value</th>
        </tr></thead>
        <tbody id="kv-body">${entries.map(kvRow).join("")}</tbody>
      </table>
    </div>`;
  $("#kv-filter").addEventListener("input", ev => {
    const q = ev.target.value.toLowerCase().trim();
    const filtered = q
      ? entries.filter(r => rowMatches(r, q))
      : entries;
    $("#kv-body").innerHTML = filtered.map(kvRow).join("");
  });
}

function rowMatches(r, q) {
  if (String(r.key ?? "").toLowerCase().includes(q)) return true;
  const v = r.value;
  if (v == null) return false;
  if (typeof v === "object") return JSON.stringify(v).toLowerCase().includes(q);
  return String(v).toLowerCase().includes(q);
}

function kvRow(r) {
  const rawVal = r.value;
  let valHtml;
  if (rawVal === null || rawVal === undefined) {
    valHtml = '<span class="pill">null</span>';
  } else if (typeof rawVal === "object") {
    valHtml = `<code>${escapeHtml(JSON.stringify(rawVal))}</code>`;
  } else if (typeof rawVal === "boolean") {
    valHtml = String(rawVal);
  } else {
    valHtml = escapeHtml(String(rawVal));
  }
  return `<tr>
    <td>${escapeHtml(r.key ?? "")}</td>
    <td><span class="pill">${escapeHtml(r.type ?? "")}</span></td>
    <td>${valHtml}</td>
  </tr>`;
}

// ---------- logs ----------
async function renderLogs() {
  const page = $("#page-logs");
  const meta = INDEX.logs || {};
  if (!meta.file || !meta.count) {
    page.innerHTML = `<h2>Logs</h2><p class="empty">No logs in export.</p>`;
    return;
  }
  if (!LOGS) LOGS = await fetchJson(meta.file);

  page.innerHTML = `
    <h2>Logs <span class="pill">${LOGS.length}</span></h2>
    <div class="toolbar">
      <label>From <input type="datetime-local" id="log-from" step="1"></label>
      <label>To <input type="datetime-local" id="log-to" step="1"></label>
      <label>Tag <input type="text" id="log-tag" placeholder="regex"></label>
      <label>Grep <input type="text" id="log-grep" placeholder="regex in msg"></label>
      ${["V","D","I","W","E","A"].map(l =>
        `<label><input type="checkbox" class="log-lvl" value="${l}" checked>${l}</label>`).join("")}
    </div>
    <div class="log-pane" id="log-pane"></div>`;

  ["log-from", "log-to", "log-tag", "log-grep"].forEach(id =>
    $(`#${id}`).addEventListener("input", applyLogFilter));
  $$(".log-lvl").forEach(cb => cb.addEventListener("change", applyLogFilter));
  applyLogFilter();
}

function applyLogFilter() {
  const levels = new Set($$(".log-lvl:checked").map(cb => cb.value));
  const from = $("#log-from").value;
  const to = $("#log-to").value;
  const tagRe = safeRegex($("#log-tag").value);
  const grepRe = safeRegex($("#log-grep").value);
  const fromZ = from ? localToIso(from) : null;
  const toZ = to ? localToIso(to) : null;

  const pane = $("#log-pane");
  const rows = [];
  let total = 0;
  for (const e of LOGS) {
    if (!levels.has(e.lvl)) continue;
    if (fromZ && (e.ts || "") < fromZ) continue;
    if (toZ && (e.ts || "") > toZ) continue;
    if (tagRe && !tagRe.test(e.tag || "")) continue;
    if (grepRe && !grepRe.test(e.msg || "")) continue;
    total++;
    if (total <= 5000) rows.push(logRowHtml(e));
  }
  let html = rows.join("");
  if (total > 5000) {
    html += `<div class="empty" style="padding: 10px">(showing 5000 of ${total} — tighten filters)</div>`;
  } else if (total === 0) {
    html = `<div class="empty" style="padding: 10px">no matches</div>`;
  }
  pane.innerHTML = html;
}

function localToIso(v) {
  // <input type="datetime-local"> yields "2026-04-19T17:13:00" (local time).
  // Convert to the Z-based format the log entries use.
  const d = new Date(v);
  if (isNaN(d)) return null;
  return d.toISOString();
}

function safeRegex(v) {
  if (!v) return null;
  try { return new RegExp(v, "i"); } catch (e) { return null; }
}

function logRowHtml(e) {
  const ts = (e.ts || "").replace("T", " ").replace("Z", "").slice(0, 23);
  const lvl = e.lvl || "?";
  const msg = escapeHtml(e.msg || "");
  const tag = e.tag || "—";
  const thread = e.thread || "";
  const trace = e.t ? `<div class="log-traceback">${escapeHtml(e.t)}</div>` : "";
  return `<div class="log-row log-${escapeHtml(lvl)}">
      <span class="log-ts">${escapeHtml(ts)}</span>
      <span class="log-lvl">${escapeHtml(lvl)}</span>
      <span class="log-thread" title="${escapeHtml(thread)}">${escapeHtml(thread)}</span>
      <span class="log-tag" title="${escapeHtml(tag)}">${escapeHtml(tag)}</span>
      <span class="log-msg">${msg}</span>
    </div>${trace}`;
}

// ---------- boot ----------
async function boot() {
  try {
    INDEX = await (await fetch("data/index.json")).json();
  } catch (e) {
    document.body.innerHTML = `<div class="error-banner" style="margin:30px">Failed to load data/index.json — run <code>analyse.py</code> first.</div>`;
    return;
  }
  $("#export-path").textContent = INDEX.export || "";
  $$(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = btn.dataset.page;
      setActivePage(p);
      if (p === "overview") renderOverview();
      else if (p === "databases") renderDatabases();
      else if (p === "datastore") renderDataStore();
      else if (p === "shared_prefs") renderSharedPrefs();
      else if (p === "logs") renderLogs();
    });
  });
  renderOverview();
}

boot();
