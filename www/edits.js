// Lokalna edycja planu: osobna warstwa zmian nałożona na plan z USOS/iCal.
// Oryginał zostaje nietknięty, więc „Przywróć oryginał” po prostu kasuje warstwę.
//
// plan.edits = {
//   occ:    { [occKey]: patch },     // zmiana tylko jednych zajęć (ten tydzień)
//   series: { [seriesKey]: patch },  // zmiana co tydzień (ten sam przedmiot, dzień i godzina)
//   custom: [ { id, summary, typeKey, location, date:'YYYY-MM-DD', startMin, endMin, weekly, until } ],
// }
// patch = { hidden?, dayShift?, startMin?, endMin?, location?, summary?, typeKey? }

const DAY = 86400000;

export const TYPES = [
  { key: 'wyk', code: 'W', label: 'Wykład', cvar: 'wyk' },
  { key: 'cw', code: 'Ć', label: 'Ćwiczenia', cvar: 'cw' },
  { key: 'lab', code: 'L', label: 'Laboratorium', cvar: 'lab' },
  { key: 'proj', code: 'P', label: 'Projekt', cvar: 'proj' },
  { key: 'sem', code: 'S', label: 'Seminarium', cvar: 'sem' },
  { key: 'lek', code: 'J', label: 'Lektorat', cvar: 'sem' },
  { key: 'egz', code: 'E', label: 'Egzamin / kolokwium', cvar: 'egz' },
  { key: 'inne', code: '•', label: 'Inne', cvar: 'inne' },
];
export const typeByKey = (k) => TYPES.find((t) => t.key === k) || null;

export const SOURCE_COLORS = ['#7aa2ff', '#ff9f5c', '#5fd38d', '#c58bff', '#ff6b8b', '#5cd6e0'];

export function emptyEdits() { return { occ: {}, series: {}, custom: [] }; }
export function hasEdits(e) {
  return !!e && (Object.keys(e.occ || {}).length > 0 || Object.keys(e.series || {}).length > 0);
}

const pad = (n) => String(n).padStart(2, '0');
export const minutesOf = (ts) => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
export const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export function parseMin(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(s || '');
  return m ? +m[1] * 60 + +m[2] : null;
}
export function isoDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function dateTs(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function dayStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function at(dayTs, min) { const d = new Date(dayTs); d.setHours(Math.floor(min / 60), min % 60, 0, 0); return d.getTime(); }
function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }

// Klucze liczone z ORYGINALNYCH zajęć (przed edycją).
export function occKey(ev) {
  return `${ev.custom ? `c:${ev.cid}` : ev.comp || ev.uid || ev.summary}|${ev.start}`;
}
export function seriesKey(ev) {
  const wd = (new Date(ev.start).getDay() + 6) % 7;
  return `${ev.custom ? `c:${ev.cid}` : ev.comp || ev.summary}|${wd}|${fmtMin(minutesOf(ev.start))}`;
}

export function expandCustom(list) {
  const out = [];
  for (const c of list || []) {
    if (!c || !c.date) continue;
    const first = dateTs(c.date);
    const last = c.weekly ? dateTs(c.until || isoDate(addDays(first, 7 * 15))) : first;
    for (let d = first, n = 0; d <= last && n < 60; d = addDays(d, 7), n++) {
      out.push({
        uid: `c-${c.id}-${isoDate(d)}`,
        cid: c.id,
        custom: true,
        summary: c.summary || 'Moje zajęcia',
        location: c.location || '',
        description: 'Dodane przez Ciebie',
        allDay: false,
        start: at(d, c.startMin),
        end: at(d, c.endMin),
        typeKey: c.typeKey || 'inne',
      });
      if (!c.weekly) break;
    }
  }
  return out;
}

// Nakłada zmiany na listę zajęć. showHidden: ukryte zostają z flagą hidden (dla trybu edycji).
export function applyEdits(events, edits, { showHidden = false } = {}) {
  const e = edits || {};
  const all = [...(events || []), ...expandCustom(e.custom)];
  const out = [];
  for (const ev of all) {
    const ok = occKey(ev);
    const sk = seriesKey(ev);
    const ps = (e.series || {})[sk];
    const po = (e.occ || {})[ok];
    if (!ps && !po) { out.push({ ...ev, okey: ok, skey: sk }); continue; }
    const p = { ...(ps || {}), ...(po || {}) };
    if (p.hidden && !showHidden) continue;
    const base = dayStart(ev.start);
    const day = addDays(base, p.dayShift || 0);
    const sMin = p.startMin ?? minutesOf(ev.start);
    const eMin = p.endMin ?? minutesOf(ev.end);
    out.push({
      ...ev,
      start: at(day, sMin),
      end: at(day, Math.max(eMin, sMin + 5)),
      summary: p.summary ?? ev.summary,
      location: p.location ?? ev.location,
      typeKey: p.typeKey ?? ev.typeKey,
      hidden: !!p.hidden,
      edited: true,
      editScope: po ? 'occ' : 'series',
      orig: ev,
      okey: ok,
      skey: sk,
    });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

// Łatka opisująca różnicę między oryginałem a wartościami z formularza.
export function makePatch(orig, v) {
  const p = {};
  const oDay = dayStart(orig.start);
  const shift = Math.round((dayStart(v.dayTs) - oDay) / DAY);
  if (shift) p.dayShift = shift;
  if (v.startMin !== minutesOf(orig.start)) p.startMin = v.startMin;
  if (v.endMin !== minutesOf(orig.end)) p.endMin = v.endMin;
  if ((v.location || '') !== (orig.location || '')) p.location = v.location || '';
  if (v.summary && v.summary !== orig.summary) p.summary = v.summary;
  if (v.typeKey && v.typeKey !== (orig.typeKey || v.origTypeKey)) p.typeKey = v.typeKey;
  return p;
}
