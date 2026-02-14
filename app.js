/* =========================
   CONFIG
   ========================= */

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

// FNV-1a 32-bit hash
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

// 16-hex using two FNV passes
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
  // typical nav/footer phrases in this system
  return (
    (s.includes("back one month") && s.includes("previous month")) ||
    (s.includes("next month") && s.includes("forward one month")) ||
    s.includes("back one year") ||
    s.includes("forward one year") ||
    s.includes("day\tweek\tmonth\tyear") ||
    (s === "day" || s === "week" || s === "month" || s === "year")
  );
}

function shouldIgnore(title, ignoreRules) {
  const t = String(title || "").trim();
  if (!t) return true;

  // Always ignore RDO (day off)
  if (t.toLowerCase() === "rdo") return true;

  // Always ignore navigation/footer content
  if (isCalendarNavLine(t)) return true;

  const lower = t.toLowerCase();
  return ignoreRules.some(rule => {
    if (rule.type === "regex") return rule.re.test(t);
    return lower.includes(rule.sub);
  });
}

// Date helpers
function makeDate(year, month, day) {
  // month: 1-12
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}
function combine(dateObj, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dateObj.getTime());
  d.setHours(h, m, 0, 0);
  return d;
}
function fmtLocalDT(dt) {
  // floating local time for ICS: YYYYMMDDTHHMMSS
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
  const offMin = -dt.getTimezoneOffset(); // minutes east of UTC
  const sign = offMin >= 0 ? "+" : "-";
  const offAbs = Math.abs(offMin);
  const offH = pad2(Math.floor(offAbs / 60));
  const offM = pad2(offAbs % 60);
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`;
}

function dateOnly(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}


/* =========================
   Parsing
   ========================= */

const DAY_LINE = /^\s*(\d{1,2})\s*$/;
const MONTH_YEAR = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i;
const ITEM_BRACKETS = /^(?<title>.+?)\[(?<range>.+?)\]\s*$/;

// Overnight special format: "22:00-03-06:00"
// Meaning: start at 22:00 on day 03, end at 06:00 on the *cell day*.
const OVERNIGHT = /^(?<start>\d{2}:\d{2})-(?<startDay>\d{2})-(?<end>\d{2}:\d{2})$/;

// Standard format: "07:00-15:00"
const STANDARD = /^(?<start>\d{2}:\d{2})-(?<end>\d{2}:\d{2})$/;

function parseMarsPaste(text, ignoreRules) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\t/g, " ").trimEnd());

  // Find month/year
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
  const globalWarnings = [];

  let i = 0;
  while (i < lines.length) {
    const dm = lines[i].match(DAY_LINE);
    if (!dm) { i++; continue; }

    const cellDay = Number(dm[1]);
    const cellDate = makeDate(year, month, cellDay);

    // Gather block lines until next day number line, stopping if footer/nav appears
    i++;
    const block = [];
    while (i < lines.length && !DAY_LINE.test(lines[i])) {
      const ln = lines[i].trim();

      if (ln && isCalendarNavLine(ln)) {
        // footer/nav content after the grid; stop reading this day block
        break;
      }

      if (ln) block.push(ln);
      i++;
    }

    for (const raw of block) {
      const line = raw.trim();
      if (!line) continue;

      // All-day entries (no brackets)
      const b = line.match(ITEM_BRACKETS);
      if (!b) {
        const title = line;
        if (shouldIgnore(title, ignoreRules)) continue;

        events.push({
          use: true,
          title,
          allDay: true,
          start: cellDate,
          end: new Date(cellDate.getTime() + 24*3600*1000),
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

      // Overnight special format
      const om = range.match(OVERNIGHT);
      if (om) {
        const startTime = om.groups.start;
        const startDay = Number(om.groups.startDay);
        const endTime = om.groups.end;

        // startDay is the actual start day-of-month; cellDay is end day-of-month
        let startDate = makeDate(year, month, startDay);

        // Month boundary case: if startDay > cellDay, startDate is in previous month
        if (startDay > cellDay) {
          const tmp = makeDate(year, month, 1);
          tmp.setMonth(tmp.getMonth() - 1);
          startDate = makeDate(tmp.getFullYear(), tmp.getMonth() + 1, startDay);
        }

        startDT = combine(startDate, startTime);
        endDT = combine(cellDate, endTime);

        if (endDT <= startDT) {
          // Safety bump; should rarely happen if format is used correctly
          endDT = new Date(endDT.getTime() + 24*3600*1000);
          warnings.push("End <= start; bumped end +1 day (review).");
        }
      } else {
        // Standard HH:MM-HH:MM
        const sm = range.match(STANDARD);
        if (!sm) {
          warnings.push(`Unrecognized time range: [${range}] (kept as all-day unless you edit)`);
          events.push({
            use: true,
            title,
            allDay: true,
            start: cellDate,
            end: new Date(cellDate.getTime() + 24*3600*1000),
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

      events.push({
        use: true,
        title,
        allDay: false,
        start: startDT,
        end: endDT,
        raw: line,
        warnings
      });
    }
  }

  return { month, year, events, globalWarnings };
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
      // Floating local times (Google imports using calendar timezone)
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

  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx];
    const tr = document.createElement("tr");

    // Use checkbox
    const tdUse = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ev.use;
    cb.addEventListener("change", () => { ev.use = cb.checked; render(); });
    tdUse.appendChild(cb);
    tr.appendChild(tdUse);

    // Date/Time
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

    // Title editable
    const tdTitle = document.createElement("td");
    const inp = document.createElement("input");
    inp.value = ev.title;
    inp.addEventListener("input", () => { ev.title = inp.value; });
    tdTitle.appendChild(inp);
    tr.appendChild(tdTitle);

    // Warnings
    const tdWarn = document.createElement("td");
    tdWarn.className = "warn";
    tdWarn.textContent = (ev.warnings || []).join(" | ");
    tr.appendChild(tdWarn);

    tbody.appendChild(tr);
  }
}

function clearSyncLog() {
  const el = document.getElementById("syncLog");
  el.textContent = "";
}

function logSync(msg) {
  const el = document.getElementById("syncLog");
  el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
}

// default ignore box content (RDO is auto-ignored anyway)
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
   Google Sync (Phase 2)
   ========================= */

let tokenClient = null;
let accessToken = null;
let accessTokenExpiryMs = 0;

function getClientId() {
  // hidden input exists; we fill it from the constant
  const box = document.getElementById("clientIdBox");
  let v = (box.value || "").trim();
  if (!v) v = DEFAULT_GOOGLE_OAUTH_CLIENT_ID;

  if (!v || v.includes("PASTE_YOUR_CLIENT_ID")) {
    throw new Error("Set DEFAULT_GOOGLE_OAUTH_CLIENT_ID in app.js to your real OAuth Client ID.");
  }

  // keep it in the hidden input for internal use
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
      if (resp.error) {
        logSync("OAuth error: " + resp.error);
        return;
      }
      accessToken = resp.access_token;
      const expiresIn = Number(resp.expires_in || 3600);
      accessTokenExpiryMs = Date.now() + (expiresIn * 1000) - 30_000; // 30s buffer
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

// Google event IDs must be lowercase base32hex [a-v0-9]; hex [0-9a-f] is OK.
// No hyphens.
function makeEventId(ev) {
  const key = `${ev.title}|${ev.allDay ? dateOnly(ev.start) : toRFC3339Local(ev.start)}|${ev.allDay ? "" : toRFC3339Local(ev.end)}|${ev.raw}`;
  return `mars${fnv1a16(key)}`;
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

function eventBodyFromParsed(ev, tz) {
  const body = {
    id: makeEventId(ev),
    summary: ev.title,
    description: `RAW: ${ev.raw}${ev.warnings?.length ? "\nWARNINGS: " + ev.warnings.join(" | ") : ""}`
  };

  if (ev.allDay) {
    body.start = { date: dateOnly(ev.start) };
    body.end = { date: dateOnly(ev.end) }; // end is non-inclusive
  } else {
    body.start = { dateTime: toRFC3339Local(ev.start), timeZone: tz };
    body.end = { dateTime: toRFC3339Local(ev.end), timeZone: tz };
  }
  return body;
}

async function upsertEvent(calendarId, body) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    await apiFetch(base, { method: "POST", body: JSON.stringify(body) });
    return "created";
  } catch (e) {
    if (e.status === 409) {
      await apiFetch(`${base}/${encodeURIComponent(body.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      return "updated";
    }
    if (e.status === 401) {
      await ensureAccessToken(true);
      await apiFetch(base, { method: "POST", body: JSON.stringify(body) });
      return "created";
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
  const end = new Date(current.year, current.month, 1, 0, 0, 0, 0); // first day next month
  return { start, end };
}

/**
 * Decide overwrite window by comparing TODAY vs the pasted month/year.
 * - Past month: no overwrite deletion (archive-friendly); sync whole month.
 * - Current month: overwrite from (today midnight - 1 day) within month (handles overnight).
 * - Future month: overwrite whole month (with a 1-day buffer before monthStart to catch overnight that starts prev day).
 */
function computeSyncWindowForPastedMonth(monthStart, monthEnd) {
  const today = new Date();
  const todayMidnight = new Date(today.getTime());
  todayMidnight.setHours(0, 0, 0, 0);

  const isPast = monthEnd <= todayMidnight;
  const isFuture = monthStart > todayMidnight;
  const isCurrent = !isPast && !isFuture;

  if (isPast) {
    return {
      label: "past-month",
      deleteFrom: null,
      syncFrom: monthStart,
      syncTo: monthEnd
    };
  }

  if (isFuture) {
    const deleteFrom = new Date(monthStart.getTime());
    deleteFrom.setDate(deleteFrom.getDate() - 1); // buffer for overnight that starts previous day
    return {
      label: "future-month",
      deleteFrom,
      syncFrom: deleteFrom,
      syncTo: monthEnd
    };
  }

  // Current month
  const from = new Date(todayMidnight.getTime());
  from.setDate(from.getDate() - 1); // yesterday midnight
  const syncFrom = new Date(Math.max(from.getTime(), monthStart.getTime()));
  return {
    label: "current-month",
    deleteFrom: syncFrom,
    syncFrom,
    syncTo: monthEnd
  };
}

// Buttons
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
    const window = computeSyncWindowForPastedMonth(monthStart, monthEnd);

    const overwrite = document.getElementById("overwriteBox").checked;

    // Explain what we’re doing (helps when pasting different months/years)
    logSync(`Pasted month detected: ${current.year}-${pad2(current.month)}. Window mode: ${window.label}.`);
    logSync(`Sync window: ${window.syncFrom.toISOString().slice(0,10)} → ${window.syncTo.toISOString().slice(0,10)} (end exclusive)`);

    // Overwrite future window only when month is current or future
    if (overwrite && window.deleteFrom) {
      logSync(`Overwriting MARS events from ${window.deleteFrom.toISOString().slice(0,10)} → end of month…`);
      const existing = await listEventsInRange(calendarId, window.deleteFrom.toISOString(), window.syncTo.toISOString());

      let deleted = 0;
      for (const item of existing) {
        if (item.id && item.id.startsWith("mars")) {
          await deleteEvent(calendarId, item.id);
          deleted++;
        }
      }
      logSync(`Deleted ${deleted} existing MARS event(s) in overwrite window.`);
    } else if (overwrite && !window.deleteFrom) {
      logSync("Pasted month is in the past; overwrite delete skipped to preserve archive.");
    }

    // Sync selected items that overlap the sync window
    const selected = current.events
      .filter(e => e.use)
      .filter(e => e.end > window.syncFrom && e.start < window.syncTo);

    logSync(`Syncing ${selected.length} selected item(s)…`);

    let created = 0, updated = 0;
    for (const ev of selected) {
      const body = eventBodyFromParsed(ev, tz);
      const result = await upsertEvent(calendarId, body);
      if (result === "created") created++;
      else updated++;
    }

    logSync(`Done: ${created} created, ${updated} updated.`);
  } catch (e) {
    logSync("Sync failed: " + (e.message || e));
  }
});

// Fill hidden client id input
try {
  document.getElementById("clientIdBox").value = DEFAULT_GOOGLE_OAUTH_CLIENT_ID || "";
} catch {}
