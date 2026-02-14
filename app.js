/* =========================
   CONFIG
   =========================
*/
const DEFAULT_GOOGLE_OAUTH_CLIENT_ID = "641865656292-2seuocq4kjjgr028dlfhjbfmucss8q0l.apps.googleusercontent.com";

/* =========================
   Utilities
   ========================= */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

function pad2(n){ return String(n).padStart(2, "0"); }

function icsEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// FNV-1a 32-bit hash -> 8 hex chars
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

// 16 hex chars from two passes (still only [0-9a-f])
function fnv1a16(str) {
  return fnv1a(str) + fnv1a(str + "|x");
}

function parseIgnoreList(raw) {
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.map(line => {
    if (line.startsWith("/") && line.endsWith("/") && line.length > 2) {
      try { return { type: "regex", re: new RegExp(line.slice(1, -1), "i"), raw: line }; }
      catch { return { type: "substr", sub: line.toLowerCase(), raw: line }; }
    }
    return { type: "substr", sub: line.toLowerCase(), raw: line };
  });
}

function isCalendarNavLine(line) {
  const s = String(line).toLowerCase();
  return (
    (s.includes("back one month") && s.includes("previous month")) ||
    (s.includes("next month") && s.includes("forward one month")) ||
    s.includes("back one year") ||
    s.includes("forward one year") ||
    (s === "day" || s === "week" || s === "month" || s === "year")
  );
}

function shouldIgnore(title, ignoreRules) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (t.toLowerCase() === "rdo") return true;          // always ignore day off
  if (isCalendarNavLine(t)) return true;               // always ignore footer/nav

  const lower = t.toLowerCase();
  return ignoreRules.some(rule => {
    if (rule.type === "regex") return rule.re.test(t);
    return lower.includes(rule.sub);
  });
}

// Date helpers
function makeDate(year, month, day) { return new Date(year, month - 1, day, 0, 0, 0, 0); }

function combine(dateObj, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dateObj.getTime());
  d.setHours(h, m, 0, 0);
  return d;
}

function fmtLocalDT(dt) {
  return `${dt.getFullYear()}${pad2(dt.getMonth()+1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
}

function fmtDateOnly(dt) {
  return `${dt.getFullYear()}${pad2(dt.getMonth()+1)}${pad2(dt.getDate())}`;
}

function toRFC3339Local(dt) {
  const y = dt.getFullYear();
  const m = pad2(dt.getMonth() + 1);
  const d = pad2(dt.getDate());
  const hh = pad2(dt.getHours());
  const mm = pad2(dt.getMinutes());
  const ss = pad2(dt.getSeconds());
  const offMin = -dt.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const offAbs = Math.abs(offMin);
  const offH = pad2(Math.floor(offAbs / 60));
  const offM = pad2(offAbs % 60);
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`;
}

function dateOnly(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`; }
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function safeKeyPart(s) { return String(s || "").replaceAll("|", " ").trim(); }

/* =========================
   Parsing
   ========================= */
const DAY_LINE = /^\s*(\d{1,2})\s*$/;
const MONTH_YEAR = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i;
const ITEM_BRACKETS = /^(?<title>.+?)\[(?<range>.+?)\]\s*$/;

// Overnight format: "22:00-03-06:00" => start 22:00 on day 03, end 06:00 on the cell day
const OVERNIGHT = /^(?<start>\d{2}:\d{2})-(?<startDay>\d{2})-(?<end>\d{2}:\d{2})$/;
// Standard: "07:00-15:00"
const STANDARD = /^(?<start>\d{2}:\d{2})-(?<end>\d{2}:\d{2})$/;

function parseMarsPaste(text, ignoreRules) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\t/g, " ").trimEnd());

  let month = null, year = null;
  for (const ln of lines) {
    const m = ln.match(MONTH_YEAR);
    if (m) {
      const mon = m[1].toLowerCase().slice(0,3);
      const full = Object.keys(MONTHS).find(k => k.startsWith(mon));
      month = MONTHS[full];
      year = Number(m[2]);
      break;
    }
  }
  if (!month || !year) throw new Error("Couldn't find Month + Year like 'February 2026'.");

  const events = [];
  const occMap = new Map(); // baseSig -> occurrence count (to avoid ID collisions)

  let i = 0;
  while (i < lines.length) {
    const dm = lines[i].match(DAY_LINE);
    if (!dm) { i++; continue; }

    const cellDay = Number(dm[1]);
    const cellDate = makeDate(year, month, cellDay);

    i++;
    const block = [];
    while (i < lines.length && !DAY_LINE.test(lines[i])) {
      const ln = lines[i].trim();
      if (ln && isCalendarNavLine(ln)) break; // stop at footer/nav
      if (ln) block.push(ln);
      i++;
    }

    for (const raw of block) {
      const line = raw.trim();
      if (!line) continue;

      const b = line.match(ITEM_BRACKETS);
      if (!b) {
        const title = line;
        if (shouldIgnore(title, ignoreRules)) continue;

        const end = new Date(cellDate.getTime() + 24*3600*1000);
        const baseSig = `A|${title}|${cellDate.getTime()}|${end.getTime()}`;
        const occ = (occMap.get(baseSig) || 0) + 1;
        occMap.set(baseSig, occ);

        events.push({
          use: true,
          title,
          sourceTitle: title,
          occ,
          allDay: true,
          start: cellDate,
          end,
          raw: line,
          warnings: []
        });
        continue;
      }

      const title = b.groups.title.trim();
      const range = b.groups.range.trim();
      if (shouldIgnore(title, ignoreRules)) continue;

      let warnings = [];
      let startDT = null, endDT = null;

      const om = range.match(OVERNIGHT);
      if (om) {
        const startTime = om.groups.start;
        const startDay = Number(om.groups.startDay);
        const endTime = om.groups.end;

        let startDate = makeDate(year, month, startDay);

        // month boundary: if startDay > cellDay, start is in previous month
        if (startDay > cellDay) {
          const tmp = makeDate(year, month, 1);
          tmp.setMonth(tmp.getMonth() - 1);
          startDate = makeDate(tmp.getFullYear(), tmp.getMonth() + 1, startDay);
        }

        startDT = combine(startDate, startTime);
        endDT = combine(cellDate, endTime);

        if (endDT <= startDT) {
          endDT = new Date(endDT.getTime() + 24*3600*1000);
          warnings.push("End <= start; bumped end +1 day (review).");
        }
      } else {
        const sm = range.match(STANDARD);
        if (!sm) {
          warnings.push(`Unrecognized time range: [${range}] (kept as all-day unless you edit)`);
          const end = new Date(cellDate.getTime() + 24*3600*1000);
          const baseSig = `A|${title}|${cellDate.getTime()}|${end.getTime()}`;
          const occ = (occMap.get(baseSig) || 0) + 1;
          occMap.set(baseSig, occ);

          events.push({
            use: true,
            title,
            sourceTitle: title,
            occ,
            allDay: true,
            start: cellDate,
            end,
            raw: line,
            warnings
          });
          continue;
        }

        startDT = combine(cellDate, sm.groups.start);
        endDT = combine(cellDate, sm.groups.end);

        if (endDT <= startDT) {
          endDT = new Date(endDT.getTime() + 24*3600*1000);
          warnings.push("Crosses midnight (end bumped +1 day).");
        }
      }

      const baseSig = `T|${title}|${startDT.getTime()}|${endDT.getTime()}`;
      const occ = (occMap.get(baseSig) || 0) + 1;
      occMap.set(baseSig, occ);

      events.push({
        use: true,
        title,
        sourceTitle: title,
        occ,
        allDay: false,
        start: startDT,
        end: endDT,
        raw: line,
        warnings
      });
    }
  }

  return { month, year, events };
}

/* =========================
   ICS generation
   ========================= */
function toICS(events) {
  const dtstamp = new Date();
  const dtstampZ = dtstamp.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/, "Z");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MARS Paste Export//EN",
    "CALSCALE:GREGORIAN"
  ];

  for (const ev of events.filter(e => e.use)) {
    const key = `${ev.title}|${ev.allDay ? fmtDateOnly(ev.start) : fmtLocalDT(ev.start)}|${ev.allDay ? "" : fmtLocalDT(ev.end)}|${ev.raw}`;
    const uid = `mars-${fnv1a16(key)}@local`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtstampZ}`);
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);

    const descBits = [];
    if (ev.warnings?.length) descBits.push("WARNINGS: " + ev.warnings.join(" | "));
    descBits.push("RAW: " + ev.raw);
    lines.push(`DESCRIPTION:${icsEscape(descBits.join("\n"))}`);

    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDateOnly(ev.start)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtDateOnly(ev.end)}`);
    } else {
      lines.push(`DTSTART:${fmtLocalDT(ev.start)}`);
      lines.push(`DTEND:${fmtLocalDT(ev.end)}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/* =========================
   UI state + rendering
   ========================= */
let current = null;

function render() {
  const tbody = document.querySelector("#eventsTable tbody");
  tbody.innerHTML = "";
  if (!current) return;

  const events = current.events;
  document.getElementById("summary").textContent =
    `Parsed ${events.length} item(s). Selected: ${events.filter(e => e.use).length}. Month: ${current.month}/${current.year}.`;

  const warnCount = events.reduce((acc,e)=>acc+(e.warnings?.length?1:0),0);
  document.getElementById("warnings").textContent =
    warnCount ? `Warnings on ${warnCount} event(s) — review before syncing.` : "";

  for (const ev of events) {
    const tr = document.createElement("tr");

    const tdUse = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ev.use;
    cb.addEventListener("change", () => { ev.use = cb.checked; render(); });
    tdUse.appendChild(cb);
    tr.appendChild(tdUse);

    const tdDT = document.createElement("td");
    if (ev.allDay) {
      tdDT.textContent = `${ev.start.getFullYear()}-${pad2(ev.start.getMonth()+1)}-${pad2(ev.start.getDate())} (all day)`;
    } else {
      const s = ev.start, e = ev.end;
      tdDT.textContent =
        `${s.getFullYear()}-${pad2(s.getMonth()+1)}-${pad2(s.getDate())} ${pad2(s.getHours())}:${pad2(s.getMinutes())} → ` +
        `${e.getFullYear()}-${pad2(e.getMonth()+1)}-${pad2(e.getDate())} ${pad2(e.getHours())}:${pad2(e.getMinutes())}`;
    }
    tr.appendChild(tdDT);

    const tdTitle = document.createElement("td");
    const inp = document.createElement("input");
    inp.value = ev.title;
    inp.addEventListener("input", () => { ev.title = inp.value; });
    tdTitle.appendChild(inp);
    tr.appendChild(tdTitle);

    const tdWarn = document.createElement("td");
    tdWarn.className = "warn";
    tdWarn.textContent = (ev.warnings || []).join(" | ");
    tr.appendChild(tdWarn);

    tbody.appendChild(tr);
  }
}

function clearSyncLog() { document.getElementById("syncLog").textContent = ""; }
function logSync(msg) {
  const el = document.getElementById("syncLog");
  el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
}

// default ignore (RDO is auto-ignored)
document.getElementById("ignoreBox").value = "NH CLASS";

document.getElementById("parseBtn").addEventListener("click", () => {
  const text = document.getElementById("pasteBox").value || "";
  const ignore = parseIgnoreList(document.getElementById("ignoreBox").value || "");
  try {
    current = parseMarsPaste(text, ignore);
    render();
  } catch (e) {
    alert(e.message || String(e));
  }
});

document.getElementById("selectAllBtn").addEventListener("click", () => {
  if (!current) return;
  current.events.forEach(e => e.use = true);
  render();
});

document.getElementById("selectNoneBtn").addEventListener("click", () => {
  if (!current) return;
  current.events.forEach(e => e.use = false);
  render();
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  if (!current) return alert("Parse first.");
  const ics = toICS(current.events);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `MARS-${current.year}-${pad2(current.month)}.ics`;
  a.click();
  URL.revokeObjectURL(url);
});

/* =========================
   Google Sync
   ========================= */
let tokenClient = null;
let accessToken = null;
let accessTokenExpiryMs = 0;

function getClientId() {
  const box = document.getElementById("clientIdBox");
  let v = (box.value || "").trim();
  if (!v) v = DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
  if (!v || v.includes("PASTE_YOUR_CLIENT_ID")) {
    throw new Error("Set DEFAULT_GOOGLE_OAUTH_CLIENT_ID in app.js to your real OAuth Client ID.");
  }
  box.value = v;
  return v;
}

function initGoogleTokenClient() {
  const clientId = getClientId();
  if (!window.google?.accounts?.oauth2) {
    throw new Error("Google OAuth library not loaded yet. Refresh and try again.");
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: "https://www.googleapis.com/auth/calendar",
    callback: (resp) => {
      if (resp.error) { logSync("OAuth error: " + resp.error); return; }
      accessToken = resp.access_token;
      const expiresIn = Number(resp.expires_in || 3600);
      accessTokenExpiryMs = Date.now() + (expiresIn * 1000) - 30_000;
      logSync("Connected.");
    }
  });
}

async function ensureAccessToken(interactive = false) {
  if (accessToken && Date.now() < accessTokenExpiryMs) return accessToken;
  if (!tokenClient) initGoogleTokenClient();

  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      accessToken = resp.access_token;
      const expiresIn = Number(resp.expires_in || 3600);
      accessTokenExpiryMs = Date.now() + (expiresIn * 1000) - 30_000;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}

async function apiFetch(url, options = {}) {
  const token = await ensureAccessToken(false);
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// Match keys (exact + "loose" without occ to self-heal if occ shifts)
function matchKeyFromParsed(ev, tz) {
  const src = safeKeyPart(ev.sourceTitle || ev.title);
  const occ = ev.occ || 1;
  if (ev.allDay) return `D|${dateOnly(ev.start)}|${dateOnly(ev.end)}|${src}|${occ}|${tz}`;
  return `T|${toRFC3339Local(ev.start)}|${toRFC3339Local(ev.end)}|${src}|${occ}|${tz}`;
}
function looseKeyFromParsed(ev, tz) {
  const src = safeKeyPart(ev.sourceTitle || ev.title);
  if (ev.allDay) return `D|${dateOnly(ev.start)}|${dateOnly(ev.end)}|${src}|${tz}`;
  return `T|${toRFC3339Local(ev.start)}|${toRFC3339Local(ev.end)}|${src}|${tz}`;
}
function looseKeyFromMatchKey(mk) {
  const parts = String(mk || "").split("|");
  if (parts.length !== 6) return null; // expected: type|start|end|src|occ|tz
  const [type, start, end, src, _occ, tz] = parts;
  return `${type}|${start}|${end}|${src}|${tz}`;
}

// Google event IDs must be lowercase base32hex [a-v0-9] (hex [0-9a-f] is OK). No hyphens.
function makeEventIdFromMatchKey(mk) {
  return `mars${fnv1a16(mk)}`;
}

async function getOrCreateCalendarIdByName(name) {
  const list = await apiFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
  const found = (list.items || []).find(c => (c.summary || "") === name);
  if (found) return found.id;

  const created = await apiFetch("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST",
    body: JSON.stringify({ summary: name })
  });
  return created.id;
}

function eventPatchBodyFromParsed(ev, tz, mkExact) {
  const body = {
    summary: ev.title,
    description: `RAW: ${ev.raw}${ev.warnings?.length ? "\nWARNINGS: " + ev.warnings.join(" | ") : ""}`,
    extendedProperties: { private: { marsMatchKey: mkExact } }
  };

  if (ev.allDay) {
    body.start = { date: dateOnly(ev.start) };
    body.end = { date: dateOnly(ev.end) };
  } else {
    body.start = { dateTime: toRFC3339Local(ev.start), timeZone: tz };
    body.end = { dateTime: toRFC3339Local(ev.end), timeZone: tz };
  }
  return body;
}

async function patchEvent(calendarId, googleEventId, body) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`;
  await apiFetch(url, { method: "PATCH", body: JSON.stringify(body) });
}

// Insert with deterministic ID; if 409 happens anyway, patch instead
async function insertEvent(calendarId, eventId, body) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const insertBody = { id: eventId, ...body };
  try {
    await apiFetch(base, { method: "POST", body: JSON.stringify(insertBody) });
  } catch (e) {
    if (e.status === 409) {
      await patchEvent(calendarId, eventId, body);
      return;
    }
    throw e;
  }
}

async function listEventsInRange(calendarId, timeMinIso, timeMaxIso) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  let pageToken = null;
  const items = [];

  do {
    const url =
      `${base}?singleEvents=true&maxResults=2500` +
      `&timeMin=${encodeURIComponent(timeMinIso)}&timeMax=${encodeURIComponent(timeMaxIso)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const res = await apiFetch(url);
    items.push(...(res.items || []));
    pageToken = res.nextPageToken || null;
  } while (pageToken);

  return items;
}

async function deleteEvent(calendarId, eventId) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  await apiFetch(url, { method: "DELETE" });
}

function monthRangeFromCurrent() {
  if (!current) throw new Error("Parse a month first.");
  const start = new Date(current.year, current.month - 1, 1, 0, 0, 0, 0);
  const end = new Date(current.year, current.month, 1, 0, 0, 0, 0); // end-exclusive
  return { start, end };
}

function buildExistingIndex(items) {
  // exact: mkExact -> [eventId...]
  // loose: mkLoose -> [eventId...]
  const exact = new Map();
  const loose = new Map();

  for (const it of items) {
    if (!it?.id || !String(it.id).startsWith("mars")) continue;

    const stored = it.extendedProperties?.private?.marsMatchKey;
    if (!stored) continue; // only trust stored keys for matching (reliable)

    if (!exact.has(stored)) exact.set(stored, []);
    exact.get(stored).push(it.id);

    const lk = looseKeyFromMatchKey(stored);
    if (lk) {
      if (!loose.has(lk)) loose.set(lk, []);
      loose.get(lk).push(it.id);
    }
  }
  return { exact, loose };
}

document.getElementById("connectBtn").addEventListener("click", async () => {
  clearSyncLog();
  try {
    initGoogleTokenClient();
    logSync("Requesting Google permission…");
    await ensureAccessToken(true);
    logSync("Ready to sync.");
  } catch (e) {
    logSync("Connect failed: " + (e.message || e));
  }
});

document.getElementById("syncBtn").addEventListener("click", async () => {
  clearSyncLog();
  try {
    if (!current) throw new Error("Parse a month first.");

    logSync("Checking Google auth…");
    await ensureAccessToken(false);

    const calName = (document.getElementById("calendarNameBox").value || "Work (MARS)").trim();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    logSync(`Using calendar: ${calName}`);
    const calendarId = await getOrCreateCalendarIdByName(calName);
    logSync("Calendar OK.");

    const { start: monthStart, end: monthEnd } = monthRangeFromCurrent();

    // buffer 1 day back to capture overnight shifts that start the previous day
    const syncRangeStart = addDays(monthStart, -1);
    const syncRangeEnd = monthEnd;

    const now = new Date();
    const nowPlus1s = new Date(now.getTime() + 1000); // avoid deleting something that starts "exactly now"

    logSync(`Now: ${now.toISOString()}`);
    logSync(`Pasted month: ${current.year}-${pad2(current.month)}`);
    logSync(`Month range: ${monthStart.toISOString().slice(0,10)} → ${monthEnd.toISOString().slice(0,10)} (end exclusive)`);
    logSync(`Sync range (w/ buffer): ${syncRangeStart.toISOString().slice(0,10)} → ${syncRangeEnd.toISOString().slice(0,10)} (end exclusive)`);

    const selected = current.events
      .filter(e => e.use)
      .filter(e => e.end > syncRangeStart && e.start < syncRangeEnd)
      .sort((a,b) => a.start - b.start);

    // FUTURE rule: delete everything in the future window, then recreate
    const futureFrom = new Date(Math.max(nowPlus1s.getTime(), syncRangeStart.getTime()));
    let deleted = 0;

    if (futureFrom < syncRangeEnd) {
      logSync(`Deleting future MARS events (start > now) from ${futureFrom.toISOString()} → ${syncRangeEnd.toISOString()} …`);
      const futureItems = await listEventsInRange(calendarId, futureFrom.toISOString(), syncRangeEnd.toISOString());
      for (const it of futureItems) {
        if (it?.id && String(it.id).startsWith("mars")) {
          await deleteEvent(calendarId, it.id);
          deleted++;
        }
      }
      logSync(`Deleted ${deleted} future MARS event(s).`);
    } else {
      logSync("No future window inside this pasted month; skipping future delete.");
    }

    // Past/current: patch when possible (archive), otherwise insert
    const pastTo = new Date(Math.min(now.getTime(), syncRangeEnd.getTime()));
    let idx = { exact: new Map(), loose: new Map() };

    if (syncRangeStart < pastTo) {
      logSync(`Indexing existing past/current MARS events from ${syncRangeStart.toISOString()} → ${pastTo.toISOString()} …`);
      const pastItems = await listEventsInRange(calendarId, syncRangeStart.toISOString(), pastTo.toISOString());
      idx = buildExistingIndex(pastItems);
      const countMars = pastItems.filter(it => it?.id && String(it.id).startsWith("mars")).length;
      logSync(`Indexed ${countMars} MARS event(s) in past/current window.`);
    }

    let patched = 0, patchedLoose = 0, created = 0;

    for (const ev of selected) {
      const isFuture = ev.start.getTime() > now.getTime(); // "happening now" counts as past/current

      const mkExact = matchKeyFromParsed(ev, tz);
      const mkLoose = looseKeyFromParsed(ev, tz);
      const body = eventPatchBodyFromParsed(ev, tz, mkExact);
      const newId = makeEventIdFromMatchKey(mkExact);

      if (!isFuture) {
        // Prefer exact match; if not found, try loose match (self-heals occ shifts)
        let existingId = null;

        const exactCandidates = idx.exact.get(mkExact);
        if (exactCandidates && exactCandidates.length) {
          existingId = exactCandidates.shift();
        } else {
          const looseCandidates = idx.loose.get(mkLoose);
          if (looseCandidates && looseCandidates.length) {
            existingId = looseCandidates.shift();
          }
        }

        if (existingId) {
          await patchEvent(calendarId, existingId, body);
          if (existingId && !idx.exact.has(mkExact)) patchedLoose++;
          else patched++;
        } else {
          await insertEvent(calendarId, newId, body);
          created++;
        }
      } else {
        // Future is recreated fresh
        await insertEvent(calendarId, newId, body);
        created++;
      }
    }

    logSync(`Done. Patched (exact): ${patched}. Patched (loose/healed): ${patchedLoose}. Created (new/recreated): ${created}. Future deleted: ${deleted}.`);
  } catch (e) {
    logSync("Sync failed: " + (e.message || e));
  }
});

// Fill hidden client id input
try {
  document.getElementById("clientIdBox").value = DEFAULT_GOOGLE_OAUTH_CLIENT_ID || "";
} catch {}
