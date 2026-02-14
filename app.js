// ---- Utilities ----
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

function isCalendarNavLine(line) {
  const s = String(line).toLowerCase();
  // common nav/footer phrases from this system
  return (
    (s.includes("back one month") && s.includes("previous month")) ||
    (s.includes("next month") && s.includes("forward one month")) ||
    s.includes("back one year") ||
    s.includes("forward one year") ||
    s === "day" || s === "week" || s === "month" || s === "year"
  );
}

// Small deterministic hash (FNV-1a) for stable UIDs
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
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

function shouldIgnore(title, ignoreRules) {
  if (isCalendarNavLine(title)) return true;

  const t = title.toLowerCase();
  return ignoreRules.some(rule => {
    if (rule.type === "regex") return rule.re.test(title);
    return t.includes(rule.sub);
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
  // "floating" local time for ICS: YYYYMMDDTHHMMSS
  return `${dt.getFullYear()}${pad2(dt.getMonth()+1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}${pad2(dt.getSeconds())}`;
}
function fmtDateOnly(dt) {
  return `${dt.getFullYear()}${pad2(dt.getMonth()+1)}${pad2(dt.getDate())}`;
}

// ---- Parsing ----
const DAY_LINE = /^\s*(\d{1,2})\s*$/;
const MONTH_YEAR = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i;
const ITEM_BRACKETS = /^(?<title>.+?)\[(?<range>.+?)\]\s*$/;

// overnight format you described: "22:00-03-06:00"
const OVERNIGHT = /^(?<start>\d{2}:\d{2})-(?<startDay>\d{2})-(?<end>\d{2}:\d{2})$/;

// standard format: "07:00-15:00"
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

    // Gather block lines until next day number line
    i++;
    const block = [];
    while (i < lines.length && !DAY_LINE.test(lines[i])) {
        const ln = lines[i].trim();

        if (ln && isCalendarNavLine(ln)) {
            // Footer/nav content after the calendar grid; stop reading this day block.
            break;
        }

        if (ln) block.push(ln);
        i++;
    }


    for (const raw of block) {
      const b = raw.match(ITEM_BRACKETS);
      if (!b) {
        // all-day marker like RDO, or other notes
        const title = raw.trim();
        if (!title) continue;
        if (shouldIgnore(title, ignoreRules)) continue;
        events.push({
          use: true,
          title,
          allDay: true,
          start: cellDate,
          end: new Date(cellDate.getTime() + 24*3600*1000),
          raw,
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

        // startDay is the *actual* start day-of-month (possibly previous month)
        let startDate = makeDate(year, month, startDay);

        // If startDay > cellDay, it likely rolled over month boundary (e.g., cell is 1, startDay is 31)
        if (startDay > cellDay) {
          const tmp = makeDate(year, month, 1);
          tmp.setMonth(tmp.getMonth() - 1);
          startDate = makeDate(tmp.getFullYear(), tmp.getMonth() + 1, startDay);
        }

        startDT = combine(startDate, startTime);
        endDT = combine(cellDate, endTime);

        // Safety: if something still weird, bump end forward
        if (endDT <= startDT) {
          endDT = new Date(endDT.getTime() + 24*3600*1000);
          warnings.push("End <= start; bumped end +1 day (review).");
        }
      } else {
        // Standard HH:MM-HH:MM
        const sm = range.match(STANDARD);
        if (!sm) {
          warnings.push(`Unrecognized time range: [${range}] (kept as all-day unless you edit)`);
          // fall back to all-day so it doesn't disappear
          events.push({
            use: true,
            title,
            allDay: true,
            start: cellDate,
            end: new Date(cellDate.getTime() + 24*3600*1000),
            raw,
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
        raw,
        warnings
      });
    }
  }

  return { month, year, events, globalWarnings };
}

// ---- ICS generation ----
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
    const uid = `mars-${fnv1a(key)}@local`;

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

// ---- UI ----
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

document.getElementById("ignoreBox").value = "RDO\nNH CLASS";

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

// ---------------- Google Sync (Phase 2) ----------------
let tokenClient = null;
let accessToken = null;
let accessTokenExpiryMs = 0;

function logSync(msg) {
  const el = document.getElementById("syncLog");
  el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
}

function getClientId() {
  const box = document.getElementById("clientIdBox");
  const v = (box.value || "").trim();
  if (!v) throw new Error("Paste your Google OAuth Client ID first.");
  localStorage.setItem("mars_client_id", v);
  return v;
}

function initGoogleTokenClient() {
  const clientId = getClientId();
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

// 16-hex stable id using two FNV passes (good enough for this use)
function fnv1a16(str) {
  return fnv1a(str) + fnv1a(str + "|x");
}

function makeEventId(ev) {
  const key = `${ev.title}|${ev.allDay ? dateOnly(ev.start) : toRFC3339Local(ev.start)}|${ev.allDay ? "" : toRFC3339Local(ev.end)}|${ev.raw}`;
  return `mars-${fnv1a16(key)}`; // valid Google event id chars
}

async function getOrCreateCalendarIdByName(name) {
  // list calendars
  const list = await apiFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
  const found = (list.items || []).find(c => (c.summary || "") === name);
  if (found) return found.id;

  // create calendar
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
    body.end = { date: dateOnly(ev.end) }; // end is already +1 day
  } else {
    body.start = { dateTime: toRFC3339Local(ev.start), timeZone: tz };
    body.end = { dateTime: toRFC3339Local(ev.end), timeZone: tz };
  }
  return body;
}

async function upsertEvent(calendarId, body) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    // Try insert first with stable id; if exists => 409
    await apiFetch(base, { method: "POST", body: JSON.stringify(body) });
    return "created";
  } catch (e) {
    if (e.status === 409) {
      // Update existing
      await apiFetch(`${base}/${encodeURIComponent(body.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      return "updated";
    }
    if (e.status === 401) {
      // Token expired or needs prompt; try interactive once
      await ensureAccessToken(true);
      await apiFetch(base, { method: "POST", body: JSON.stringify(body) });
      return "created";
    }
    throw e;
  }
}

async function listEventsInRange(calendarId, timeMinIso, timeMaxIso) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const url = `${base}?singleEvents=true&maxResults=2500&timeMin=${encodeURIComponent(timeMinIso)}&timeMax=${encodeURIComponent(timeMaxIso)}`;
  const res = await apiFetch(url);
  return res.items || [];
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

// Wire buttons
document.getElementById("clientIdBox").value = localStorage.getItem("mars_client_id") || "";

document.getElementById("connectBtn").addEventListener("click", async () => {
  document.getElementById("syncLog").textContent = "";
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
  document.getElementById("syncLog").textContent = "";
  try {
    if (!current) throw new Error("Parse a month first.");

    logSync("Checking Google auth…");
    await ensureAccessToken(false);

    const calName = (document.getElementById("calendarNameBox").value || "Work (MARS)").trim();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    logSync(`Using calendar: ${calName}`);
    const calendarId = await getOrCreateCalendarIdByName(calName);
    logSync("Calendar OK.");

    const selected = current.events.filter(e => e.use);
    logSync(`Syncing ${selected.length} selected item(s)…`);

    let created = 0, updated = 0;
    for (const ev of selected) {
      const body = eventBodyFromParsed(ev, tz);
      const result = await upsertEvent(calendarId, body);
      if (result === "created") created++;
      else updated++;
    }
    logSync(`Done: ${created} created, ${updated} updated.`);

    // Optional pruning for this month only (keeps archive outside this month)
    const prune = document.getElementById("pruneMissingBox").checked;
    if (prune) {
      const { start, end } = monthRangeFromCurrent();
      logSync("Pruning unselected MARS events in this month…");
      const existing = await listEventsInRange(calendarId, start.toISOString(), end.toISOString());

      const keepIds = new Set(selected.map(ev => makeEventId(ev)));
      let deleted = 0;

      for (const item of existing) {
        if (item.id && item.id.startsWith("mars-") && !keepIds.has(item.id)) {
          await deleteEvent(calendarId, item.id);
          deleted++;
        }
      }
      logSync(`Prune done: ${deleted} deleted.`);
    }

  } catch (e) {
    logSync("Sync failed: " + (e.message || e));
  }
});
