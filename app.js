/* =========================================================
   MARS Calendar Importer
   Paste MARS schedule text -> review & filter -> sync to Google Calendar
   ========================================================= */
(() => {
  "use strict";

  /* ---------------- CONFIG ---------------- */
  const TZ = "America/Chicago";
  const GOOGLE_OAUTH_CLIENT_ID = "PASTE_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com";
  const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar";
  const STORAGE_KEY = "marsImporter.settings.v1";

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    paste: $("pasteBox"),
    ignore: $("ignoreBox"),
    parseBtn: $("parseBtn"),
    selectAllBtn: $("selectAllBtn"),
    selectNoneBtn: $("selectNoneBtn"),
    downloadBtn: $("downloadBtn"),
    eventList: $("eventList"),
    summary: $("summary"),
    reviewCard: $("reviewCard"),
    calName: $("calendarNameBox"),
    connectBtn: $("connectBtn"),
    syncBtn: $("syncBtn"),
    syncCard: $("syncCard"),
    syncPanel: $("syncPanel"),
    syncStatus: $("syncStatus"),
    syncBar: $("syncBar"),
    logDetails: $("logDetails"),
    syncLog: $("syncLog"),
    copyLogBtn: $("copyLogBtn"),
    clearLogBtn: $("clearLogBtn"),
  };

  /* ---------------- PERSISTED SETTINGS (localStorage) ---------------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  function saveSettings(partial) {
    const current = loadSettings();
    const merged = { ...current, ...partial };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      /* storage full or blocked; ignore silently */
    }
  }

  /* ---------------- LOG / PROGRESS ---------------- */
  let logLines = [];
  let progDone = 0;
  let progTotal = null;

  function renderLog() {
    els.syncLog.textContent = logLines.join("\n");
  }
  function log(msg) {
    logLines.push(msg);
    renderLog();
  }
  function clearLog() {
    logLines = [];
    renderLog();
  }
  function setStatus(msg) {
    els.syncStatus.textContent = msg;
  }
  function resetProgress() {
    progDone = 0;
    progTotal = null;
    setStatus("Idle.");
    els.syncBar.max = 1;
    els.syncBar.value = 0;
    els.syncPanel.classList.add("hidden");
  }
  function setTotal(totalSteps) {
    progTotal = Math.max(1, totalSteps);
    els.syncBar.max = progTotal;
    els.syncBar.value = progDone;
  }
  function step(statusMsg) {
    progDone += 1;
    if (statusMsg) setStatus(statusMsg);
    if (progTotal !== null) {
      els.syncBar.value = Math.min(progDone, progTotal);
    } else {
      els.syncBar.removeAttribute("value");
    }
  }
  function finish(statusMsg) {
    if (progTotal === null) setTotal(Math.max(1, progDone));
    els.syncBar.value = progTotal;
    setStatus(statusMsg || "Done.");
  }
  function showSyncUI() {
    els.syncPanel.classList.remove("hidden");
  }

  /* ---------------- DATE / TIME UTILS ---------------- */
  const pad2 = (n) => String(n).padStart(2, "0");

  function ymd(y, m, d) { return { y, m, d }; }
  function ymdToStr(o) { return `${o.y}-${pad2(o.m)}-${pad2(o.d)}`; }
  function ymdAddDays(o, delta) {
    const dt = new Date(Date.UTC(o.y, o.m - 1, o.d + delta));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  function monthEndYMD(year, month) {
    const dt = new Date(Date.UTC(year, month - 1, 1));
    dt.setUTCMonth(dt.getUTCMonth() + 1);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: 1 };
  }
  function shiftYearMonth(y, m, deltaMonths) {
    const dt = new Date(Date.UTC(y, m - 1, 1));
    dt.setUTCMonth(dt.getUTCMonth() + deltaMonths);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1 };
  }
  function ymdCompare(a, b) {
    if (a.y !== b.y) return a.y - b.y;
    if (a.m !== b.m) return a.m - b.m;
    return a.d - b.d;
  }
  function strToYMD(s) {
    const [y, m, d] = String(s || "").split("-").map(Number);
    if (!y || !m || !d) return null;
    return { y, m, d };
  }
  function ymdToInput(o) { return `${o.y}-${pad2(o.m)}-${pad2(o.d)}`; }

  const dtfParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  function partsInTZ(date) {
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
  function fmtCentral(date) {
    const p = partsInTZ(date);
    return `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)} (${TZ})`;
  }
  function tzOffsetMs(ts) {
    const p = partsInTZ(new Date(ts));
    const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    return asUTC - ts;
  }
  function zonedWallTimeToDate(y, m, d, hh, mm, ss = 0) {
    const utcGuess = Date.UTC(y, m - 1, d, hh, mm, ss);
    const off1 = tzOffsetMs(utcGuess);
    let ts = utcGuess - off1;
    const off2 = tzOffsetMs(ts);
    if (off2 !== off1) ts = utcGuess - off2;
    return new Date(ts);
  }
  function rfc3339LocalStr(ymdObj, hmStr) {
    return `${ymdToStr(ymdObj)}T${hmStr}:00`;
  }
  function icsEscape(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  function fmtICSLocalDT(ymdObj, hmStr) {
    const [hh, mm] = hmStr.split(":").map(Number);
    return `${ymdObj.y}${pad2(ymdObj.m)}${pad2(ymdObj.d)}T${pad2(hh)}${pad2(mm)}00`;
  }
  function fmtICSDate(ymdObj) {
    return `${ymdObj.y}${pad2(ymdObj.m)}${pad2(ymdObj.d)}`;
  }

  /* ---------------- IGNORE RULES ---------------- */
  function parseIgnoreRules(raw) {
    return String(raw || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
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
    if (t.toLowerCase() === "rdo") return true;
    if (isCalendarNavLine(t)) return true;
    const lower = t.toLowerCase();
    return rules.some((r) => (r.type === "regex" ? r.re.test(t) : lower.includes(r.sub)));
  }

  /* ---------------- MARS TEXT PARSER ---------------- */
  const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const RX_DAY = /^\s*(\d{1,2})\s*$/;
  const RX_MONTH_YEAR = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i;
  const RX_ITEM = /^(?<title>.+?)\[(?<range>.+?)\]\s*$/;
  const RX_OVERNIGHT = /^(?<start>\d{2}:\d{2})-(?<startDay>\d{2})-(?<end>\d{2}:\d{2})$/;
  const RX_STD = /^(?<start>\d{2}:\d{2})-(?<end>\d{2}:\d{2})$/;

  function findMonthYear(lines) {
    for (const ln of lines) {
      const m = ln.match(RX_MONTH_YEAR);
      if (!m) continue;
      const mon3 = m[1].toLowerCase().slice(0, 3);
      const full = Object.keys(MONTHS).find((k) => k.startsWith(mon3));
      return { month: MONTHS[full], year: Number(m[2]) };
    }
    return null;
  }
  function makeMatchKey(ev) {
    const src = String(ev.sourceTitle || "").replaceAll("|", " ").trim();
    const occ = ev.occ || 1;
    if (ev.allDay) return `D|${ymdToStr(ev.startYMD)}|${ymdToStr(ev.endYMD)}|${src}|${occ}`;
    return `T|${ymdToStr(ev.startYMD)}|${ev.startHM}|${ymdToStr(ev.endYMD)}|${ev.endHM}|${src}|${occ}`;
  }

  function parse(text, ignoreRules) {
    const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\t/g, " ").trimEnd());
    const my = findMonthYear(lines);
    if (!my) throw new Error("Couldn't find a month and year (like \"February 2026\") in the pasted text.");

    const { month, year } = my;
    const events = [];
    const occMap = new Map();
    const daysInMainMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    let startedMainMonth = false;
    let monthOffset = 0;
    let lastDayNum = null;
    let maxCellYMD = null;

    let i = 0;
    while (i < lines.length) {
      const dm = lines[i].match(RX_DAY);
      if (!dm) { i++; continue; }
      const cellDay = Number(dm[1]);

      if (!startedMainMonth) {
        if (cellDay === 1) {
          startedMainMonth = true;
          monthOffset = 0;
          lastDayNum = 1;
        } else {
          i++;
          while (i < lines.length && !RX_DAY.test(lines[i])) {
            const ln = lines[i].trim();
            if (ln && isCalendarNavLine(ln)) break;
            i++;
          }
          continue;
        }
      } else {
        if (monthOffset === 0 && lastDayNum !== null && lastDayNum >= daysInMainMonth - 3 && cellDay <= 7 && cellDay < lastDayNum) {
          monthOffset = 1;
        }
        lastDayNum = cellDay;
      }

      const ym = shiftYearMonth(year, month, monthOffset);
      const cellYMD = ymd(ym.y, ym.m, cellDay);
      if (!maxCellYMD || ymdCompare(cellYMD, maxCellYMD) > 0) maxCellYMD = cellYMD;

      i++;
      const block = [];
      while (i < lines.length && !RX_DAY.test(lines[i])) {
        const ln = lines[i].trim();
        if (ln && isCalendarNavLine(ln)) break;
        if (ln) block.push(ln);
        i++;
      }

      for (const raw of block) {
        const line = raw.trim();
        if (!line) continue;
        const mItem = line.match(RX_ITEM);

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
          events.push({ use: true, title, sourceTitle: title, occ, allDay: true, startYMD, endYMD, start, end, raw: line, warnings: [] });
          continue;
        }

        const title = mItem.groups.title.trim();
        const range = mItem.groups.range.trim();
        if (shouldIgnoreTitle(title, ignoreRules)) continue;

        const warnings = [];
        let startYMD, endYMD, startHM = null, endHM = null, start, end;
        const mOver = range.match(RX_OVERNIGHT);

        if (mOver) {
          startHM = mOver.groups.start;
          endHM = mOver.groups.end;
          const startDay = Number(mOver.groups.startDay);
          if (startDay > cellDay) {
            const prevYM = shiftYearMonth(cellYMD.y, cellYMD.m, -1);
            startYMD = ymd(prevYM.y, prevYM.m, startDay);
          } else {
            startYMD = ymd(cellYMD.y, cellYMD.m, startDay);
          }
          endYMD = cellYMD;
          const [sh, sm] = startHM.split(":").map(Number);
          const [eh, em] = endHM.split(":").map(Number);
          start = zonedWallTimeToDate(startYMD.y, startYMD.m, startYMD.d, sh, sm, 0);
          end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, eh, em, 0);
          if (end <= start) {
            endYMD = ymdAddDays(endYMD, 1);
            end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, eh, em, 0);
            warnings.push("End before start; bumped end date +1 day. Please double check.");
          }
        } else {
          const mStd = range.match(RX_STD);
          if (!mStd) {
            warnings.push(`Unrecognized time range "[${range}]" — kept as all-day. Please double check.`);
            startYMD = cellYMD;
            endYMD = ymdAddDays(cellYMD, 1);
            start = zonedWallTimeToDate(startYMD.y, startYMD.m, startYMD.d, 0, 0, 0);
            end = zonedWallTimeToDate(endYMD.y, endYMD.m, endYMD.d, 0, 0, 0);
            const baseSig = `A|${title}|${ymdToStr(startYMD)}|${ymdToStr(endYMD)}`;
            const occ = (occMap.get(baseSig) || 0) + 1;
            occMap.set(baseSig, occ);
            events.push({ use: true, title, sourceTitle: title, occ, allDay: true, startYMD, endYMD, start, end, raw: line, warnings });
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
            warnings.push("Crosses midnight; end date bumped +1 day.");
          }
        }

        const baseSig = `T|${title}|${ymdToStr(startYMD)}|${startHM}|${ymdToStr(endYMD)}|${endHM}`;
        const occ = (occMap.get(baseSig) || 0) + 1;
        occMap.set(baseSig, occ);
        events.push({ use: true, title, sourceTitle: title, occ, allDay: false, startYMD, endYMD, startHM, endHM, start, end, raw: line, warnings });
      }
    }

    if (!events.length && !startedMainMonth) {
      throw new Error("Found a month/year but no day cells with entries. Double check the paste includes the full calendar grid.");
    }

    const windowStartYMD = ymd(year, month, 1);
    const windowEndYMD = maxCellYMD ? ymdAddDays(maxCellYMD, 1) : monthEndYMD(year, month);

    for (const ev of events) {
      if (!ev.idKey) ev.idKey = makeMatchKey(ev);
    }

    return { month, year, windowStartYMD, windowEndYMD, events };
  }

  /* ---------------- ICS EXPORT (fallback, no Google needed) ---------------- */
  function toICS(events) {
    const dtstampZ = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MARS Importer//EN", "CALSCALE:GREGORIAN"];
    for (const ev of events.filter((e) => e.use)) {
      const uid = `mars-${dtstampZ}-${Math.random().toString(16).slice(2)}@local`;
      out.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${dtstampZ}`, `SUMMARY:${icsEscape(ev.title)}`);
      const desc = [ev.warnings?.length ? "WARNINGS: " + ev.warnings.join(" | ") : "", "RAW: " + ev.raw].filter(Boolean).join("\n");
      out.push(`DESCRIPTION:${icsEscape(desc)}`);
      if (ev.allDay) {
        out.push(`DTSTART;VALUE=DATE:${fmtICSDate(ev.startYMD)}`, `DTEND;VALUE=DATE:${fmtICSDate(ev.endYMD)}`);
      } else {
        out.push(`DTSTART:${fmtICSLocalDT(ev.startYMD, ev.startHM)}`, `DTEND:${fmtICSLocalDT(ev.endYMD, ev.endHM)}`);
      }
      out.push("END:VEVENT");
    }
    out.push("END:VCALENDAR");
    return out.join("\r\n") + "\r\n";
  }

  /* ---------------- UI STATE / RENDER ---------------- */
  let state = null;

  function render() {
    els.eventList.innerHTML = "";
    if (!state) {
      els.reviewCard.classList.add("hidden");
      els.syncCard.classList.add("hidden");
      return;
    }
    els.reviewCard.classList.remove("hidden");
    els.syncCard.classList.remove("hidden");

    const selected = state.events.filter((e) => e.use).length;
    els.summary.textContent = `${state.events.length} item(s) parsed for ${state.month}/${state.year} — ${selected} selected.`;

    for (const ev of state.events) {
      const card = document.createElement("div");
      card.className = "eventCard" + (ev.warnings?.length ? " hasWarning" : "");

      const top = document.createElement("div");
      top.className = "eventTop";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = ev.use;
      cb.className = "eventUse";
      cb.addEventListener("change", () => { ev.use = cb.checked; render(); });

      const titleInp = document.createElement("input");
      titleInp.type = "text";
      titleInp.className = "eventTitle";
      titleInp.value = ev.title;
      titleInp.addEventListener("input", () => { ev.title = titleInp.value; });

      top.appendChild(cb);
      top.appendChild(titleInp);
      card.appendChild(top);

      const times = document.createElement("div");
      times.className = "eventTimes";

      const startDate = document.createElement("input");
      startDate.type = "date";
      startDate.value = ymdToInput(ev.startYMD);
      const startTime = document.createElement("input");
      startTime.type = "time";
      startTime.step = 60;
      startTime.value = ev.allDay ? "" : ev.startHM || "00:00";
      startTime.disabled = ev.allDay;

      const arrow = document.createElement("span");
      arrow.className = "eventArrow";
      arrow.textContent = "\u2192";

      const endDate = document.createElement("input");
      endDate.type = "date";
      endDate.value = ymdToInput(ev.endYMD);
      const endTime = document.createElement("input");
      endTime.type = "time";
      endTime.step = 60;
      endTime.value = ev.allDay ? "" : ev.endHM || "00:00";
      endTime.disabled = ev.allDay;

      const onEdit = () => {
        const sY = strToYMD(startDate.value);
        const eY = strToYMD(endDate.value);
        if (!sY || !eY) return;
        ev.startYMD = sY;
        ev.endYMD = eY;
        if (!ev.allDay) {
          ev.startHM = startTime.value || ev.startHM || "00:00";
          ev.endHM = endTime.value || ev.endHM || "00:00";
        }
        if (ev.allDay) {
          ev.start = zonedWallTimeToDate(ev.startYMD.y, ev.startYMD.m, ev.startYMD.d, 0, 0, 0);
          ev.end = zonedWallTimeToDate(ev.endYMD.y, ev.endYMD.m, ev.endYMD.d, 0, 0, 0);
        } else {
          const [sh, sm] = ev.startHM.split(":").map(Number);
          const [eh, em] = ev.endHM.split(":").map(Number);
          ev.start = zonedWallTimeToDate(ev.startYMD.y, ev.startYMD.m, ev.startYMD.d, sh, sm, 0);
          ev.end = zonedWallTimeToDate(ev.endYMD.y, ev.endYMD.m, ev.endYMD.d, eh, em, 0);
        }
        render();
      };
      startDate.addEventListener("change", onEdit);
      endDate.addEventListener("change", onEdit);
      startTime.addEventListener("change", onEdit);
      endTime.addEventListener("change", onEdit);

      times.append(startDate, startTime, arrow, endDate, endTime);
      card.appendChild(times);

      if (ev.warnings?.length) {
        const w = document.createElement("div");
        w.className = "eventWarning";
        w.textContent = ev.warnings.join(" ");
        card.appendChild(w);
      }

      els.eventList.appendChild(card);
    }
  }

  /* ---------------- GOOGLE AUTH / SYNC ---------------- */
  let tokenClient = null;
  let accessToken = null;
  let accessExp = 0;

  function initTokenClient() {
    if (!GOOGLE_OAUTH_CLIENT_ID || GOOGLE_OAUTH_CLIENT_ID.includes("PASTE_YOUR_CLIENT_ID")) {
      throw new Error("Set GOOGLE_OAUTH_CLIENT_ID at the top of app.js to your real Client ID.");
    }
    if (!window.google?.accounts?.oauth2) {
      throw new Error("Google sign-in library hasn't loaded yet. Refresh and try again.");
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scope: GOOGLE_SCOPE,
      callback: () => {},
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
      headers: { ...(options.headers || {}), Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
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
    const found = (list.items || []).find((c) => (c.summary || "") === name);
    if (found) return found.id;
    const created = await api("https://www.googleapis.com/calendar/v3/calendars", {
      method: "POST",
      body: JSON.stringify({ summary: name }),
    });
    return created.id;
  }

  async function listEvents(calendarId, timeMinISO, timeMaxISO) {
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
    let pageToken = null;
    const items = [];
    do {
      const url = `${base}?singleEvents=true&maxResults=2500&timeMin=${encodeURIComponent(timeMinISO)}&timeMax=${encodeURIComponent(timeMaxISO)}` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const res = await api(url);
      items.push(...(res.items || []));
      pageToken = res.nextPageToken || null;
    } while (pageToken);
    return items;
  }

  async function deleteEvent(calendarId, eventId) {
    await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  }
  async function patchEvent(calendarId, eventId, body) {
    await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify(body) });
  }
  async function createEvent(calendarId, body) {
    await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(body) });
  }

  function googleBodyFromEvent(ev) {
    const idKey = ev.idKey || makeMatchKey(ev);
    const body = {
      summary: ev.title,
      description: `RAW: ${ev.raw}`,
      extendedProperties: { private: { marsApp: "1", marsIdKey: idKey } },
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

  function buildIndexByIdKey(items) {
    const map = new Map();
    for (const it of items) {
      const app = it?.extendedProperties?.private?.marsApp;
      if (app !== "1" || !it?.id) continue;
      const key = it?.extendedProperties?.private?.marsIdKey;
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it.id);
    }
    return map;
  }

  async function syncToGoogle(rep) {
    if (!state) throw new Error("Parse a month first.");
    const calName = String(els.calName.value || "Work (MARS)").trim();
    if (!calName) throw new Error("Calendar name is blank.");

    log(`Using calendar: ${calName}`);
    const calendarId = await getOrCreateCalendarIdByName(calName);
    log("Calendar ready.");
    rep.step("Calendar ready.");

    const now = new Date();
    const rangeStartYMD = state.windowStartYMD;
    const rangeEndYMD = state.windowEndYMD;
    const rangeStart = zonedWallTimeToDate(rangeStartYMD.y, rangeStartYMD.m, rangeStartYMD.d, 0, 0, 0);
    const rangeEnd = zonedWallTimeToDate(rangeEndYMD.y, rangeEndYMD.m, rangeEndYMD.d, 0, 0, 0);

    log(`Now: ${fmtCentral(now)}`);
    log(`Window: ${ymdToStr(rangeStartYMD)} to ${ymdToStr(rangeEndYMD)} (end exclusive)`);

    const selected = state.events
      .filter((e) => e.use)
      .filter((e) => e.end > rangeStart && e.start < rangeEnd)
      .sort((a, b) => a.start - b.start);

    rep.status(`Preparing... ${selected.length} item(s) selected`);
    rep.setTotal(selected.length + 3);

    const nowPlus1s = new Date(now.getTime() + 1000);
    const futureFrom = new Date(Math.max(nowPlus1s.getTime(), rangeStart.getTime()));
    let deleted = 0;

    if (futureFrom < rangeEnd) {
      log("Removing future MARS events in this month's window before re-adding...");
      const futureItems = await listEvents(calendarId, futureFrom.toISOString(), rangeEnd.toISOString());
      const toDelete = futureItems.filter((it) => it?.id && it?.extendedProperties?.private?.marsApp === "1");
      rep.setTotal(toDelete.length + selected.length + 3);
      let delN = 0;
      for (const it of toDelete) {
        await deleteEvent(calendarId, it.id);
        delN++; deleted++;
        rep.step(`Clearing future events... ${delN}/${toDelete.length}`);
      }
      log(`Removed ${deleted} future event(s).`);
    } else {
      log("No future window in this month; skipping cleanup.");
    }

    const pastTo = new Date(Math.min(now.getTime(), rangeEnd.getTime()));
    let index = new Map();
    if (rangeStart < pastTo) {
      const pastItems = await listEvents(calendarId, rangeStart.toISOString(), pastTo.toISOString());
      index = buildIndexByIdKey(pastItems);
      log(`Found ${pastItems.filter((it) => it?.extendedProperties?.private?.marsApp === "1").length} existing past/current event(s) to match against.`);
    }
    rep.step("Indexed existing events.");

    let patched = 0, created = 0, n = 0;
    for (const ev of selected) {
      n++;
      rep.step(`Syncing... ${n}/${selected.length}`);
      const key = ev.idKey || makeMatchKey(ev);
      const body = googleBodyFromEvent(ev);
      const isFuture = ev.start.getTime() > now.getTime();
      if (!isFuture) {
        const q = index.get(key);
        if (q && q.length) {
          await patchEvent(calendarId, q.shift(), body);
          patched++;
        } else {
          await createEvent(calendarId, body);
          created++;
        }
      } else {
        await createEvent(calendarId, body);
        created++;
      }
    }

    rep.step("Finishing up...");
    log(`Done. Updated: ${patched}. Created: ${created}. Removed: ${deleted}.`);
  }

  /* ---------------- WIRE UI ---------------- */
  function init() {
    const settings = loadSettings();
    if (settings.ignoreText != null) els.ignore.value = settings.ignoreText;
    if (settings.calendarName) els.calName.value = settings.calendarName;

    els.ignore.addEventListener("input", () => saveSettings({ ignoreText: els.ignore.value }));
    els.calName.addEventListener("input", () => saveSettings({ calendarName: els.calName.value }));

    els.parseBtn.addEventListener("click", () => {
      try {
        const rules = parseIgnoreRules(els.ignore.value);
        state = parse(els.paste.value, rules);
        render();
        els.reviewCard.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {
        alert(e.message || String(e));
      }
    });

    els.selectAllBtn.addEventListener("click", () => { if (state) { state.events.forEach((e) => (e.use = true)); render(); } });
    els.selectNoneBtn.addEventListener("click", () => { if (state) { state.events.forEach((e) => (e.use = false)); render(); } });

    els.downloadBtn.addEventListener("click", () => {
      if (!state) return alert("Parse a month first.");
      const ics = toICS(state.events);
      const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `MARS-${state.year}-${pad2(state.month)}.ics`;
      a.click();
      URL.revokeObjectURL(url);
    });

    els.connectBtn.addEventListener("click", async () => {
      clearLog(); resetProgress(); showSyncUI();
      els.logDetails.open = false;
      try {
        setStatus("Requesting Google permission...");
        log("Requesting Google permission...");
        await ensureToken(true);
        setTotal(1);
        step("Connected.");
        finish("Connected.");
      } catch (e) {
        log("Connect failed: " + (e.message || e));
        setStatus("Connect failed (see log).");
        els.logDetails.open = true;
      }
    });

    els.syncBtn.addEventListener("click", async () => {
      clearLog(); resetProgress(); showSyncUI();
      els.logDetails.open = false;

      const rep = { setTotal, step, status: setStatus, log };

      const run = async (interactive) => {
        setStatus("Checking Google sign-in...");
        await ensureToken(interactive);
        step("Signed in.");
        await syncToGoogle(rep);
        finish("Sync complete.");
        log("Sync complete.");
      };

      try {
        await run(false);
      } catch (e) {
        const msg = String(e?.message || e || "");
        if (msg.includes("401") || msg.toLowerCase().includes("invalid_token")) {
          try {
            log("Sign-in expired; requesting permission again...");
            await run(true);
            return;
          } catch (e2) {
            log("Sync failed: " + (e2.message || e2));
            setStatus("Sync failed (see log).");
            els.logDetails.open = true;
            return;
          }
        }
        log("Sync failed: " + (e.message || e));
        setStatus("Sync failed (see log).");
        els.logDetails.open = true;
      }
    });

    els.copyLogBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(logLines.join("\n")); setStatus("Log copied."); }
      catch { setStatus("Couldn't copy log."); }
    });
    els.clearLogBtn.addEventListener("click", () => { clearLog(); resetProgress(); });

    render();
  }

  init();
})();
