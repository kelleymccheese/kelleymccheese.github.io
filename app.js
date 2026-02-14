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
