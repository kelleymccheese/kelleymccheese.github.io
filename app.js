/* =========================
   MARS Paste → ICS + Google Sync
   ========================= */
(() => {
  "use strict";

  /* ====== CONFIG ====== */
  const TZ = "America/Chicago";
  const GOOGLE_OAUTH_CLIENT_ID = "P641865656292-2seuocq4kjjgr028dlfhjbfmucss8q0l.apps.googleusercontent.com";
  const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";
  const DEFAULT_IGNORE_TEXT = ""; //RDO is always ignored

  /* ====== DOM ====== */
  const $ = (id) => document.getElementById(id);
  const els = {
    paste: $("pasteBox"),
    ignore: $("ignoreBox"),
    parse: $("parseBtn"),
    selAll: $("selectAllBtn"),
    selNone: $("selectNoneBtn"),
    dl: $("downloadBtn"),
    tableBody: document.querySelector("#eventsTable tbody"),
    summary: $("summary"),
    warnings: $("warnings"),
    calName: $("calendarNameBox"),
    connect: $("connectBtn"),
    sync: $("syncBtn"),
    log: $("syncLog"),
  };

  /* ====== LOG ====== */
  function log(msg) {
    els.log.textContent = (els.log.textContent ? els.log.textContent + "\n" : "") + msg;
  }
  function clearLog() { els.log.textContent = ""; }

  /* ====== SMALL UTILS ====== */
  const pad2 = (n) => String(n).padStart(2, "0");

  // Calendar-safe YMD helper using UTC math (no DST surprises)
  function ymd(y, m, d) { return { y, m, d }; }
  function ymdToStr(o) { return `${o.y}-${pad2(o.m)}-${pad2(o.d)}`; }
  function ymdAddDays(o, delta) {
    const dt = new Date(Date.UTC(o.y, o.m - 1, o.d + delta));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  function monthStartYMD(year, month) { return { y: year, m: month, d: 1 }; }
  function monthEndYMD(year, month) {
    const dt = new Date(Date.UTC(year, month - 1, 1));
    dt.setUTCMonth(dt.getUTCMonth() + 1);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: 1 }; // first of next month
  }

  // Intl formatter for getting timezone-aware parts
  const dtfParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  function partsInTZ(date) {
    function fmtCentral(date) {
        const p = partsInTZ(date);
        return `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)} (${TZ})`;
    }
    const parts = dtfParts.formatToParts(date);
    const out = {};
    for (const p of parts) {
      if (p.type === "year") out.y = Number(p.value);
      if (p.type === "month") out.m = Number(p.value);
      if (p.type === "day") out.d = Number(p.value);
      if (p.type === "hour") out.hh = Number(p.value);
      if (p.type === "minute") out.mm = Number(p.value);
      if (p.type === "second") out.ss = Number(p.value);
    }
    return out;
  }

  // Offset of TZ relative to UTC at timestamp ts (ms): e.g. -21600000 for CST
  function tzOffsetMs(ts) {
    const p = partsInTZ(new Date(ts));
    const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    return asUTC - ts;
  }

  // Convert a wall-time in TZ to a real Date (UTC instant), independent of device timezone.
  function zonedWallTimeToDate(y, m, d, hh, mm, ss = 0) {
    const utcGuess = Date.UTC(y, m - 1, d, hh, mm, ss);
    const off1 = tzOffsetMs(utcGuess);
    let ts = utcGuess - off1;
    const off2 = tzOffsetMs(ts);
    if (off2 !== off1) ts = utcGuess - off2; // one refinement handles DST boundaries
    return new Date(ts);
  }

  // Central “YYYY-MM-DDTHH:MM:SS” string for Google (no offset; timeZone provided separately)
  function rfc3339LocalStr(ymdObj, hmStr) {
    return `${ymdToStr(ymdObj)}T${hmStr}:00`;
  }

  function icsEscape(s) {
    return String(s)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  function fmtICSLocalDT(ymdObj, hmStr) {
    // ICS local DT (floating); we keep it as Central wall time
    const [hh, mm] = hmStr.split(":").map(Number);
    return `${ymdObj.y}${pad2(ymdObj.m)}${pad2(ymdObj.d)}T${pad2(hh)}${pad2(mm)}00`;
  }

  function fmtICSDate(ymdObj) {
    return `${ymdObj.y}${pad2(ymdObj.m)}${pad2(ymdObj.d)}`;
  }

  /* ====== IGNORE RULES ====== */
  function parseIgnoreRules(raw) {
    const lines = String(raw || "")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);

    return lines.map(line => {
      if (line.startsWith("/") && line.endsWith("/") && line.length > 2) {
        try { return { type: "regex", re: new RegExp(line.slice(1, -1), "i") }; }
        catch { return { type: "substr", sub: line.toLowerCase() }; }
      }
      return { type: "substr", sub: line.toLowerCase() };
    });
  }

  function isCalendarNavLine(line) {
    const s = String(line).toLowerCase();
    return (
      (s.includes("back one month") && s.includes("previous month")) ||
      (s.includes("next month") && s.includes("forward one month")) ||
      s.includes("back one year") ||
      s.includes("forward one year")
    );
  }

  function shouldIgnoreTitle(title, rules) {
    const t = String(title || "").trim();
    if (!t) return true;
    if (t.toLowerCase() === "rdo") return true;    // always ignore day off
    if (isCalendarNavLine(t)) return true;         // ignore footer/nav noise

    const lower = t.toLowerCase();
    return rules.some(r => (r.type === "regex" ? r.re.test(t) : lower.includes(r.sub)));
  }

  /* ====== PARSER ====== */
  const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };

  const RX_DAY = /^\s*(\d{1,2})\s*$/;
  const RX_MONTH_YEAR = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i;
  const RX_ITEM = /^(?<title>.+?)\[(?<range>.+?)\]\s*$/;
  const RX_OVERNIGHT = /^(?<start>\d{2}:\d{2})-(?<startDay>\d{2})-(?<end>\d{2}:\d{2})$/; // 22:00-03-06:00
  const RX_STD = /^(?<start>\d{2}:\d{2})-(?<end>\d{2}:\d{2})$/; // 07:00-15:00

  function findMonthYear(lines) {
    for (const ln of lines) {
      const m = ln.match(RX_MONTH_YEAR);
      if (!m) continue;
      const mon3 = m[1].toLowerCase().slice(0, 3);
      const full = Object.keys(MONTHS).find(k => k.startsWith(mon3));
      return { month: MONTHS[full], year: Number(m[2]) };
    }
    return null;
  }

  // Stable match key: wall time in Central + source title + occurrence
  function makeMatchKey(ev) {
    const src = String(ev.sourceTitle || "").replaceAll("|", " ").trim();
    const occ = ev.occ || 1;

    if (ev.allDay) {
      return `D|${ymdToStr(ev.startYMD)}|${ymdToStr(ev.endYMD)}|${src}|${occ}`;
    }
    return `T|${ymdToStr(ev.startYMD)}|${ev.startHM}|${ymdToStr(ev.endYMD)}|${ev.endHM}|${src}|${occ}`;
  }

  function parse(text, ignoreRules) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map(l => l.replace(/\t/g, " ").trimEnd());

    const my = findMonthYear(lines);
    if (!my) throw new Error("Couldn't find Month + Year like 'February 2026'.");

    const { month, year } = my;
    const events = [];
    const occMap = new Map(); // baseSig -> count

    let i = 0;
    while (i < lines.length) {
      const dm = lines[i].match(RX_DAY);
      if (!dm) { i++; continue; }

      const cellDay = Number(dm[1]);
      const cellYMD = ymd(year, month, cellDay);

      i++;
      const block = [];
      while (i < lines.length && !RX_DAY.test(lines[i])) {
        const ln = lines[i].trim();
        if (ln && isCalendarNavLine(ln)) break; // stop at footer/nav
        if (ln) block.push(ln);
        i++;
      }

      for (const raw of block) {
        const line = raw.trim();
        if (!line) continue;

        const mItem = line.match(RX_ITEM);

        // No brackets => all-day label
        if (!mItem) {
          const title = line;
          if (shouldIgnoreTitle(title, ignoreRules)) continue;

          const startYMD = cellYMD;
          const endYMD = ymdAddDays(cellYMD, 1);
          const start = zonedWallTimeToDate(startYMD.y, startYMD.m, startYMD.d, 0, 0, 0);
          const end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, 0, 0, 0);

          const baseSig = `A|${title}|${ymdToStr(startYMD)}|${ymdToStr(endYMD)}`;
          const occ = (occMap.get(baseSig) || 0) + 1;
          occMap.set(baseSig, occ);

          events.push({
            use: true,
            title,
            sourceTitle: title,
            occ,
            allDay: true,
            startYMD,
            endYMD,
            start,
            end,
            raw: line,
            warnings: []
          });
          continue;
        }

        const title = mItem.groups.title.trim();
        const range = mItem.groups.range.trim();
        if (shouldIgnoreTitle(title, ignoreRules)) continue;

        const warnings = [];
        let startYMD = null, endYMD = null;
        let startHM = null, endHM = null;
        let start = null, end = null;

        const mOver = range.match(RX_OVERNIGHT);
        if (mOver) {
          startHM = mOver.groups.start;
          endHM = mOver.groups.end;
          const startDay = Number(mOver.groups.startDay);

          // start day can be in previous month (if startDay > cellDay)
          if (startDay > cellDay) {
            const prev = new Date(Date.UTC(year, month - 1, 1));
            prev.setUTCMonth(prev.getUTCMonth() - 1);
            startYMD = ymd(prev.getUTCFullYear(), prev.getUTCMonth() + 1, startDay);
          } else {
            startYMD = ymd(year, month, startDay);
          }

          endYMD = cellYMD;

          const [sh, sm] = startHM.split(":").map(Number);
          const [eh, em] = endHM.split(":").map(Number);

          start = zonedWallTimeToDate(startYMD.y, startYMD.m, startYMD.d, sh, sm, 0);
          end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, eh, em, 0);

          if (end <= start) {
            endYMD = ymdAddDays(endYMD, 1);
            end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, eh, em, 0);
            warnings.push("End <= start; bumped end +1 day (review).");
          }
        } else {
          const mStd = range.match(RX_STD);
          if (!mStd) {
            // fallback: all-day
            warnings.push(`Unrecognized time range: [${range}] (kept as all-day unless you edit)`);

            startYMD = cellYMD;
            endYMD = ymdAddDays(cellYMD, 1);
            start = zonedWallTimeToDate(startYMD.y, startYMD.m, startYMD.d, 0, 0, 0);
            end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, 0, 0, 0);

            const baseSig = `A|${title}|${ymdToStr(startYMD)}|${ymdToStr(endYMD)}`;
            const occ = (occMap.get(baseSig) || 0) + 1;
            occMap.set(baseSig, occ);

            events.push({
              use: true,
              title,
              sourceTitle: title,
              occ,
              allDay: true,
              startYMD,
              endYMD,
              start,
              end,
              raw: line,
              warnings
            });
            continue;
          }

          startHM = mStd.groups.start;
          endHM = mStd.groups.end;
          startYMD = cellYMD;
          endYMD = cellYMD;

          const [sh, sm] = startHM.split(":").map(Number);
          const [eh, em] = endHM.split(":").map(Number);

          start = zonedWallTimeToDate(startYMD.y, startYMD.m, startYMD.d, sh, sm, 0);
          end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, eh, em, 0);

          if (end <= start) {
            endYMD = ymdAddDays(endYMD, 1);
            end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, eh, em, 0);
            warnings.push("Crosses midnight (end bumped +1 day).");
          }
        }

        const baseSig = `T|${title}|${ymdToStr(startYMD)}|${startHM}|${ymdToStr(endYMD)}|${endHM}`;
        const occ = (occMap.get(baseSig) || 0) + 1;
        occMap.set(baseSig, occ);

        events.push({
          use: true,
          title,
          sourceTitle: title,
          occ,
          allDay: false,
          startYMD,
          endYMD,
          startHM,
          endHM,
          start,
          end,
          raw: line,
          warnings
        });
      }
    }

    return { month, year, events };
  }

  /* ====== ICS ====== */
  function toICS(events) {
    const dtstampZ = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const out = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//MARS Paste Export//EN",
      "CALSCALE:GREGORIAN"
    ];

    for (const ev of events.filter(e => e.use)) {
      const uid = `mars-${dtstampZ}-${Math.random().toString(16).slice(2)}@local`;
      out.push("BEGIN:VEVENT");
      out.push(`UID:${uid}`);
      out.push(`DTSTAMP:${dtstampZ}`);
      out.push(`SUMMARY:${icsEscape(ev.title)}`);

      const desc = [
        ev.warnings?.length ? ("WARNINGS: " + ev.warnings.join(" | ")) : "",
        "RAW: " + ev.raw
      ].filter(Boolean).join("\n");
      out.push(`DESCRIPTION:${icsEscape(desc)}`);

      if (ev.allDay) {
        out.push(`DTSTART;VALUE=DATE:${fmtICSDate(ev.startYMD)}`);
        out.push(`DTEND;VALUE=DATE:${fmtICSDate(ev.endYMD)}`); // end-exclusive
      } else {
        out.push(`DTSTART:${fmtICSLocalDT(ev.startYMD, ev.startHM)}`);
        out.push(`DTEND:${fmtICSLocalDT(ev.endYMD, ev.endHM)}`);
      }
      out.push("END:VEVENT");
    }

    out.push("END:VCALENDAR");
    return out.join("\r\n") + "\r\n";
  }

  /* ====== UI ====== */
  let state = null;

  function render() {
    els.tableBody.innerHTML = "";
    if (!state) {
      els.summary.textContent = "";
      els.warnings.textContent = "";
      return;
    }

    const events = state.events;
    const selected = events.filter(e => e.use).length;
    els.summary.textContent = `Parsed ${events.length} item(s). Selected: ${selected}. Month: ${state.month}/${state.year}.`;

    const warnCount = events.reduce((a, e) => a + (e.warnings?.length ? 1 : 0), 0);
    els.warnings.textContent = warnCount ? `Warnings on ${warnCount} event(s) — review before syncing.` : "";

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
        tdDT.textContent = `${ymdToStr(ev.startYMD)} (all day)`;
      } else {
        tdDT.textContent = `${ymdToStr(ev.startYMD)} ${ev.startHM} → ${ymdToStr(ev.endYMD)} ${ev.endHM}`;
      }
      tr.appendChild(tdDT);

      const tdTitle = document.createElement("td");
      const inp = document.createElement("input");
      inp.value = ev.title;
      inp.addEventListener("input", () => { ev.title = inp.value; });
      tdTitle.appendChild(inp);
      tr.appendChild(tdTitle);

      const tdW = document.createElement("td");
      tdW.className = "warn";
      tdW.textContent = (ev.warnings || []).join(" | ");
      tr.appendChild(tdW);

      els.tableBody.appendChild(tr);
    }
  }

  /* ====== GOOGLE SYNC ====== */
  let tokenClient = null;
  let accessToken = null;
  let accessExp = 0;

  function initTokenClient() {
    if (!GOOGLE_OAUTH_CLIENT_ID || GOOGLE_OAUTH_CLIENT_ID.includes("PASTE_YOUR_CLIENT_ID")) {
      throw new Error("Set GOOGLE_OAUTH_CLIENT_ID at the top of app.js to your real Client ID.");
    }
    if (!window.google?.accounts?.oauth2) {
      throw new Error("Google OAuth library not loaded yet. Refresh and try again.");
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope: GOOGLE_SCOPE,
      callback: () => {}
    });
  }

  async function ensureToken(interactive) {
    if (accessToken && Date.now() < accessExp) return accessToken;
    if (!tokenClient) initTokenClient();

    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        accessToken = resp.access_token;
        const expiresIn = Number(resp.expires_in || 3600);
        accessExp = Date.now() + expiresIn * 1000 - 30_000;
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    });
  }

  async function api(url, options = {}) {
    const tok = await ensureToken(false);
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        "Authorization": `Bearer ${tok}`,
        "Content-Type": "application/json"
      }
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  async function getOrCreateCalendarIdByName(name) {
    const list = await api("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
    const found = (list.items || []).find(c => (c.summary || "") === name);
    if (found) return found.id;

    const created = await api("https://www.googleapis.com/calendar/v3/calendars", {
      method: "POST",
      body: JSON.stringify({ summary: name })
    });
    return created.id;
  }

  async function listEvents(calendarId, timeMinISO, timeMaxISO) {
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    let pageToken = null;
    const items = [];

    do {
      const url =
        `${base}?singleEvents=true&maxResults=2500` +
        `&timeMin=${encodeURIComponent(timeMinISO)}&timeMax=${encodeURIComponent(timeMaxISO)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const res = await api(url);
      items.push(...(res.items || []));
      pageToken = res.nextPageToken || null;
    } while (pageToken);

    return items;
  }

  async function deleteEvent(calendarId, eventId) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    await api(url, { method: "DELETE" });
  }

  async function patchEvent(calendarId, eventId, body) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    await api(url, { method: "PATCH", body: JSON.stringify(body) });
  }

  async function createEvent(calendarId, body) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    await api(url, { method: "POST", body: JSON.stringify(body) });
  }

  function googleBodyFromEvent(ev) {
    const mk = makeMatchKey(ev);
    const body = {
      summary: ev.title,
      description: `RAW: ${ev.raw}${ev.warnings?.length ? "\nWARNINGS: " + ev.warnings.join(" | ") : ""}`,
      extendedProperties: { private: { marsApp: "1", marsMatchKey: mk } }
    };

    if (ev.allDay) {
      body.start = { date: ymdToStr(ev.startYMD) };
      body.end = { date: ymdToStr(ev.endYMD) };
    } else {
      body.start = { dateTime: rfc3339LocalStr(ev.startYMD, ev.startHM), timeZone: TZ };
      body.end = { dateTime: rfc3339LocalStr(ev.endYMD, ev.endHM), timeZone: TZ };
    }
    return body;
  }

  function buildIndexByMatchKey(items) {
    const map = new Map(); // marsMatchKey -> [eventId,...]
    for (const it of items) {
      const mk = it?.extendedProperties?.private?.marsMatchKey;
      const app = it?.extendedProperties?.private?.marsApp;
      if (!it?.id || app !== "1" || !mk) continue;
      if (!map.has(mk)) map.set(mk, []);
      map.get(mk).push(it.id);
    }
    return map;
  }

  async function syncToGoogle() {
    if (!state) throw new Error("Parse a month first.");

    const calName = String(els.calName.value || "Work (MARS)").trim();
    if (!calName) throw new Error("Calendar name is blank.");

    log(`Using calendar: ${calName}`);
    const calendarId = await getOrCreateCalendarIdByName(calName);
    log("Calendar OK.");

    const now = new Date();
    const nowPlus1s = new Date(now.getTime() + 1000);

    // Window is ONLY this pasted month (plus 1-day buffer backward for overnights).
    const mStartYMD = monthStartYMD(state.year, state.month);
    const mEndYMD = monthEndYMD(state.year, state.month);
    const rangeStartYMD = ymdAddDays(mStartYMD, -1);
    const rangeEndYMD = mEndYMD;

    const rangeStart = zonedWallTimeToDate(rangeStartYMD.y, rangeStartYMD.m, rangeStartYMD.d, 0, 0, 0);
    const rangeEnd = zonedWallTimeToDate(rangeEndYMD.y, rangeEndYMD.m, rangeEndYMD.d, 0, 0, 0);

    log(`Now (Central): ${fmtCentral(now)}`);
    log(`Now (UTC): ${now.toISOString()}`); // optional, but useful for debugging
    log(`Pasted month: ${state.year}-${pad2(state.month)}`);
    log(`Month range: ${ymdToStr(mStartYMD)} → ${ymdToStr(mEndYMD)} (end exclusive)`);
    log(`Sync range (w/ buffer): ${ymdToStr(rangeStartYMD)} → ${ymdToStr(rangeEndYMD)} (end exclusive)`);

    const selected = state.events
      .filter(e => e.use)
      .filter(e => e.end > rangeStart && e.start < rangeEnd)
      .sort((a, b) => a.start - b.start);

    // FUTURE delete is ONLY within [max(now+1s, rangeStart), rangeEnd)
    const futureFrom = new Date(Math.max(nowPlus1s.getTime(), rangeStart.getTime()));
    let deleted = 0;

    if (futureFrom < rangeEnd) {
      log(`Deleting future MARS events ONLY for this pasted month window…`);
      log(`Delete window (Central): ${fmtCentral(futureFrom)} → ${fmtCentral(rangeEnd)} (end exclusive)`);
      log(`Delete window (UTC): ${futureFrom.toISOString()} → ${rangeEnd.toISOString()} (end exclusive)`); // optional

      const futureItems = await listEvents(calendarId, futureFrom.toISOString(), rangeEnd.toISOString());
      for (const it of futureItems) {
        const app = it?.extendedProperties?.private?.marsApp;
        if (it?.id && app === "1") {
          await deleteEvent(calendarId, it.id);
          deleted++;
        }
      }
      log(`Deleted ${deleted} future MARS event(s).`);
    } else {
      log("No future window inside this pasted month; skipping future delete.");
    }

    // Past/current patch: index only within [rangeStart, min(now, rangeEnd))
    const pastTo = new Date(Math.min(now.getTime(), rangeEnd.getTime()));
    let index = new Map();

    if (rangeStart < pastTo) {
      log(`Indexing existing past/current MARS events within this month window (Central now=${fmtCentral(now)})…`);
      const pastItems = await listEvents(calendarId, rangeStart.toISOString(), pastTo.toISOString());
      index = buildIndexByMatchKey(pastItems);
      log(`Indexed ${pastItems.filter(it => it?.extendedProperties?.private?.marsApp === "1").length} MARS event(s) in past/current window.`);
    }

    let patched = 0, created = 0;

    for (const ev of selected) {
      const mk = makeMatchKey(ev);
      const body = googleBodyFromEvent(ev);

      // “Happening now” counts as past/current (archive → patch)
      const isFuture = ev.start.getTime() > now.getTime();

      if (!isFuture) {
        const q = index.get(mk);
        if (q && q.length) {
          const eventId = q.shift();
          await patchEvent(calendarId, eventId, body);
          patched++;
        } else {
          await createEvent(calendarId, body);
          created++;
        }
      } else {
        // Future is recreated fresh (we deleted future ones in-window)
        await createEvent(calendarId, body);
        created++;
      }
    }

    log(`Done. Patched (past/current): ${patched}. Created (new/recreated): ${created}. Future deleted (in-month only): ${deleted}.`);
  }

  /* ====== WIRE UI ====== */
  function initDefaults() {
    if (els.ignore && !els.ignore.value) els.ignore.value = DEFAULT_IGNORE_TEXT;
  }

  els.parse?.addEventListener("click", () => {
    try {
      const ignoreRules = parseIgnoreRules(els.ignore.value);
      state = parse(els.paste.value, ignoreRules);
      render();
    } catch (e) {
      alert(e.message || String(e));
    }
  });

  els.selAll?.addEventListener("click", () => {
    if (!state) return;
    state.events.forEach(e => e.use = true);
    render();
  });

  els.selNone?.addEventListener("click", () => {
    if (!state) return;
    state.events.forEach(e => e.use = false);
    render();
  });

  els.dl?.addEventListener("click", () => {
    if (!state) return alert("Parse first.");
    const ics = toICS(state.events);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `MARS-${state.year}-${pad2(state.month)}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  });

  els.connect?.addEventListener("click", async () => {
    clearLog();
    try {
      initTokenClient();
      log("Requesting Google permission…");
      await ensureToken(true);
      log("Connected.");
    } catch (e) {
      log("Connect failed: " + (e.message || e));
    }
  });

  els.sync?.addEventListener("click", async () => {
    clearLog();
    try {
      log("Checking Google auth…");
      await ensureToken(false);
      await syncToGoogle();
    } catch (e) {
      // If token needs user gesture/consent again, try interactive once.
      const msg = String(e.message || "");
      if (msg.includes("401") || msg.toLowerCase().includes("invalid_token")) {
        try {
          log("Auth expired; requesting permission again…");
          await ensureToken(true);
          await syncToGoogle();
          return;
        } catch (e2) {
          log("Sync failed: " + (e2.message || e2));
          return;
        }
      }
      log("Sync failed: " + (e.message || e));
    }
  });

  initDefaults();
  render();
})();
