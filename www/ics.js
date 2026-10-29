// Parser plików iCalendar (.ics) + porównywanie wersji planu.
// Bez zależności — działa w przeglądarce i w Node (testy).

const MAX_OCCURRENCES = 500;

function unescapeText(v) {
  return v.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function parseLine(line) {
  // NAZWA;PARAM=x;PARAM2="a:b":WARTOŚĆ
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

// Przesunięcie strefy czasowej (ms) w danej chwili.
function tzOffset(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ts))) p[type] = value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - Math.floor(ts / 1000) * 1000;
}

// Czas „na zegarze” w strefie tz -> znacznik czasu.
function wallToTs(w, tz) {
  if (tz) {
    try {
      const guess = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
      let ts = guess - tzOffset(guess, tz);
      const off2 = tzOffset(ts, tz);
      ts = guess - off2;
      return ts;
    } catch (e) { /* nieznana strefa -> czas lokalny */ }
  }
  return new Date(w.y, w.mo, w.d, w.h, w.mi, w.s).getTime();
}

function parseDateValue(value, params) {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const w = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: 0, mi: 0, s: 0 };
    return { wall: w, utc: false, tz: null, allDay: true, ts: wallToTs(w, null) };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const w = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  if (m[7]) {
    return { wall: w, utc: true, tz: null, allDay: false, ts: Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) };
  }
  const tz = params && params.TZID ? params.TZID : null;
  return { wall: w, utc: false, tz, allDay: false, ts: wallToTs(w, tz) };
}

function addDaysWall(w, days) {
  const d = new Date(Date.UTC(w.y, w.mo, w.d + days));
  return { ...w, y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() };
}

function shiftDate(dt, days) {
  if (dt.utc) return { ...dt, ts: dt.ts + days * 86400000 };
  const w = addDaysWall(dt.wall, days);
  return { ...dt, wall: w, ts: wallToTs(w, dt.tz) };
}

function parseRRule(v) {
  const r = {};
  for (const part of v.split(';')) {
    const [k, val] = part.split('=');
    if (k && val !== undefined) r[k.toUpperCase()] = val;
  }
  return r;
}

export function parseICS(text) {
  if (typeof text !== 'string' || !/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('To nie jest plik kalendarza (brak BEGIN:VCALENDAR).');
  }
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const raw = [];
  let cur = null;
  let depth = 0; // zagnieżdżone bloki (np. VALARM) wewnątrz VEVENT
  for (const line of lines) {
    if (!line) continue;
    const up = line.toUpperCase();
    if (up === 'BEGIN:VEVENT') { cur = { exdates: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (up.startsWith('BEGIN:')) { depth++; continue; }
    if (up.startsWith('END:')) {
      if (depth > 0) { depth--; continue; }
      if (up === 'END:VEVENT') { raw.push(cur); cur = null; }
      continue;
    }
    if (depth > 0) continue;
    const p = parseLine(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(p.value).trim(); break;
      case 'LOCATION': cur.location = unescapeText(p.value).trim(); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value).trim(); break;
      case 'DTSTART': cur.start = parseDateValue(p.value, p.params); break;
      case 'DTEND': cur.end = parseDateValue(p.value, p.params); break;
      case 'DURATION': cur.duration = p.value.trim(); break;
      case 'RRULE': cur.rrule = parseRRule(p.value.trim()); break;
      case 'EXDATE':
        for (const x of p.value.split(',')) {
          const d = parseDateValue(x, p.params);
          if (d) cur.exdates.push(d.ts);
        }
        break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(p.value, p.params); break;
      case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
      default: break;
    }
  }

  const overrides = new Set();
  for (const r of raw) if (r.recurrenceId && r.uid) overrides.add(r.uid + '|' + r.recurrenceId.ts);

  const events = [];
  for (const r of raw) {
    if (!r.start) continue;
    if (r.status === 'CANCELLED') continue;
    let durMs = r.end ? r.end.ts - r.start.ts : parseDuration(r.duration);
    if (!(durMs >= 0)) durMs = r.start.allDay ? 86400000 : 0;
    const base = {
      uid: r.uid || '',
      summary: r.summary || '(bez nazwy)',
      location: r.location || '',
      description: r.description || '',
      allDay: !!r.start.allDay,
    };
    const push = (dt) => events.push({ ...base, start: dt.ts, end: dt.ts + durMs });

    if (!r.rrule || r.recurrenceId) { push(r.start); continue; }

    const freq = (r.rrule.FREQ || '').toUpperCase();
    const step = freq === 'DAILY' ? 1 : freq === 'WEEKLY' ? 7 : 0;
    if (!step) { push(r.start); continue; }
    const interval = Math.max(1, parseInt(r.rrule.INTERVAL || '1', 10));
    const count = r.rrule.COUNT ? parseInt(r.rrule.COUNT, 10) : Infinity;
    const until = r.rrule.UNTIL ? parseDateValue(r.rrule.UNTIL, {}) : null;
    const untilTs = until ? (until.allDay ? until.ts + 86399999 : until.ts) : Infinity;
    const ex = new Set(r.exdates);
    let dt = r.start;
    for (let n = 0; n < Math.min(count, MAX_OCCURRENCES); n++) {
      if (dt.ts > untilTs) break;
      if (!ex.has(dt.ts) && !overrides.has(base.uid + '|' + dt.ts)) push(dt);
      dt = shiftDate(dt, step * interval);
    }
  }
  events.sort((a, b) => a.start - b.start || a.end - b.end || a.summary.localeCompare(b.summary));
  return events;
}

function parseDuration(v) {
  if (!v) return NaN;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) return NaN;
  const ms = ((+(m[2] || 0)) * 7 * 86400 + (+(m[3] || 0)) * 86400 +
    (+(m[4] || 0)) * 3600 + (+(m[5] || 0)) * 60 + (+(m[6] || 0))) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// Rodzaj zajęć na podstawie tytułu/opisu.
export function classType(ev) {
  const t = (ev.summary + ' ' + ev.description).toLowerCase();
  if (/wykład|wyklad|\bwyk\b|lecture/.test(t)) return { code: 'W', label: 'Wykład', key: 'wyk' };
  if (/laborator|\blab\b/.test(t)) return { code: 'L', label: 'Laboratorium', key: 'lab' };
  if (/ćwicz|cwicz|\bćw\b|\bcw\b|exercise|tutorial/.test(t)) return { code: 'Ć', label: 'Ćwiczenia', key: 'cw' };
  if (/projekt|project/.test(t)) return { code: 'P', label: 'Projekt', key: 'proj' };
  if (/seminar/.test(t)) return { code: 'S', label: 'Seminarium', key: 'sem' };
  if (/lektorat|język obcy|jezyk obcy/.test(t)) return { code: 'J', label: 'Lektorat', key: 'lek' };
  if (/egzamin|exam|kolokwium|zaliczen/.test(t)) return { code: 'E', label: 'Egzamin', key: 'egz' };
  return { code: '•', label: 'Zajęcia', key: 'inne' };
}

// Porównanie starej i nowej wersji planu (tylko zajęcia od `fromTs`).
// Zwraca listę zmian: added / removed / moved / room.
export function diffEvents(oldEvents, newEvents, fromTs) {
  const relevant = (list) => (list || []).filter((e) => e.end >= fromTs);
  const key = (e) => e.summary + '|' + e.start + '|' + e.end;
  const oldMap = new Map(relevant(oldEvents).map((e) => [key(e), e]));
  const newMap = new Map(relevant(newEvents).map((e) => [key(e), e]));
  const changes = [];
  const added = [];
  const removed = [];
  for (const [k, e] of newMap) {
    const o = oldMap.get(k);
    if (!o) added.push(e);
    else if ((o.location || '') !== (e.location || '')) changes.push({ type: 'room', before: o, after: e });
  }
  for (const [k, e] of oldMap) if (!newMap.has(k)) removed.push(e);

  // Ta sama nazwa w odległości do 7 dni -> traktujemy jako przeniesienie.
  const usedAdded = new Set();
  for (const r of removed) {
    let best = -1;
    let bestDist = Infinity;
    added.forEach((a, i) => {
      if (usedAdded.has(i) || a.summary !== r.summary) return;
      const dist = Math.abs(a.start - r.start);
      if (dist <= 7 * 86400000 && dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best >= 0) { usedAdded.add(best); changes.push({ type: 'moved', before: r, after: added[best] }); }
    else changes.push({ type: 'removed', before: r });
  }
  added.forEach((a, i) => { if (!usedAdded.has(i)) changes.push({ type: 'added', after: a }); });
  const when = (c) => (c.after || c.before).start;
  changes.sort((a, b) => when(a) - when(b));
  return changes;
}

// Zamienia webcal:// na https:// i czyści spacje.
export function normalizeUrl(u) {
  let s = (u || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, 'https://');
  return s;
}
