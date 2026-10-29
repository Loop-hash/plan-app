import { parseICS, classType, diffEvents, normalizeUrl } from './ics.js';
import {
  FACULTIES, urls, parseSubjects, parseGroups, parsePrograms, parseCycles, pickCycle, parsePlan, components,
  isSelected, toEvent, mondayISO, isoToTs, codePrefix,
} from './usos.js';
import {
  TYPES, typeByKey, SOURCE_COLORS, emptyEdits, hasEdits, applyEdits, makePatch, occKey, seriesKey,
  minutesOf, fmtMin, parseMin, isoDate, dateTs,
} from './edits.js';
import { sendFeedback, canSendDirect, canAttach, shrinkImage, recentErrors, logError } from './feedback.js';
import { isNative, hasUpdater, currentBuild, checkUpdate, applyUpdate, markStarted, openInstallSettings, RELEASE_PAGE } from './updater.js';

const STORE_KEY = 'planapp.v1';
const AUTO_REFRESH_MS = 30 * 60 * 1000;
const DAY = 86400000;

// ---------- stan ----------
let state = load();
let selDate = startOfDay(Date.now());
let refreshing = false;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && Array.isArray(s.plans)) return { view: 'day', ...s, settings: { theme: 'blueprint', weekends: false, ...(s.settings || {}) } };
  } catch (e) { /* brak/uszkodzone dane */ }
  return { plans: [], activeId: null, view: 'day', settings: { theme: 'blueprint', weekends: false } };
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Nie udało się zapisać danych na telefonie.'); }
}
const activePlan = () => state.plans.find((p) => p.id === state.activeId) || state.plans[0] || null;

// ---------- pomocnicze ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return startOfDay(d.getTime()); }
function startOfWeek(ts) { const d = new Date(startOfDay(ts)); const wd = (d.getDay() + 6) % 7; return addDays(d.getTime(), -wd); }
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'short' });
const fmtShort = (ts) => new Date(ts).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
const fmtDateTime = (ts) => new Date(ts).toLocaleString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const wdShort = (ts) => new Date(ts).toLocaleDateString('pl-PL', { weekday: 'short' }).replace('.', '');
function dur(ms) {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'przed chwilą';
  if (m < 60) return `${m} min temu`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h temu`;
  return fmtDateTime(ts);
}
// Zajęcia do pokazania: plan (albo połączone plany) + Twoje zmiany.
let evMemo = null;
let editMode = false;
function computeEvents(plan, depth = 0) {
  let base;
  if (plan.kind === 'merge') {
    base = [];
    (plan.sources || []).forEach((s, i) => {
      const p = state.plans.find((x) => x.id === s.id);
      if (!p || p.kind === 'merge' || depth > 0) return;
      for (const e of computeEvents(p, depth + 1)) base.push({ ...e, srcColor: s.color, srcName: p.name, srcIdx: i, comp: `${s.id}:${e.comp || e.uid || e.summary}` });
    });
    base.sort((a, b) => a.start - b.start || a.end - b.end);
  } else base = plan.events || [];
  return applyEdits(base, plan.edits, { showHidden: editMode && depth === 0 });
}
function viewEvents(plan) {
  if (!plan) return [];
  if (evMemo && evMemo.id === plan.id && evMemo.edit === editMode) return evMemo.list;
  const list = computeEvents(plan);
  evMemo = { id: plan.id, edit: editMode, list };
  return list;
}
function eventsOn(plan, dayTs) {
  const end = addDays(dayTs, 1);
  return viewEvents(plan).filter((e) => e.start < end && e.end > dayTs);
}
const planReady = (plan) => (plan.kind === 'merge' ? (plan.sources || []).some((s) => state.plans.find((p) => p.id === s.id)?.events) || !!plan.edits?.custom?.length : !!plan.events);
const planSources = (plan) => (plan.kind === 'merge' ? (plan.sources || []).map((s) => state.plans.find((p) => p.id === s.id)).filter(Boolean) : [plan]);
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}
const zajec = (n) => (n === 1 ? 'zajęcia' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'zajęcia' : 'zajęć');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const uid = () => Math.random().toString(36).slice(2, 10);

// Ładne rozbicie tytułu z USOS: "Przedmiot - Wykład" / "Przedmiot (WYK) gr. 1"
function splitTitle(ev) {
  const type = (ev.typeKey && typeByKey(ev.typeKey)) || classType(ev);
  let title = ev.summary;
  title = title.replace(/\s*[-–,:]\s*(wykład|ćwiczenia|laboratorium|projekt|seminarium|lektorat|wyk|ćw|lab)\b.*$/i, '');
  title = title.replace(/\s*\((wykład|ćwiczenia|laboratorium|projekt|seminarium|wyk|ćw|cw|lab|proj)[^)]*\)\s*$/i, '');
  if (!title.trim()) title = ev.summary;
  return { type, title: title.trim() };
}
// kolor zajęć: kierunek w połączonym planie, inaczej rodzaj zajęć
const colorOf = (ev, type) => ev.srcColor || `var(--${type.cvar || type.key})`;
const srcTag = (ev) => (ev.srcName ? `<span class="src-tag" style="--s:${ev.srcColor}"><i></i>${esc(ev.srcName)}</span>` : '');
let reg = [];
const regEv = (ev) => reg.push(ev) - 1;

// ---------- pobieranie ----------
async function fetchPlanText(url) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 25000) : null;
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl?.signal });
    if (!res.ok) throw new Error(`Serwer odpowiedział błędem ${res.status}.`);
    return await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Przekroczono czas oczekiwania — sprawdź internet.');
    if (e instanceof TypeError) throw new Error('Brak połączenia z serwerem — sprawdź internet.');
    throw e;
  } finally { if (timer) clearTimeout(timer); }
}

// --- plany z katalogu USOS (wybrane z listy) ---
const WEEKS_AHEAD = 4;
function rebuildUsosEvents(plan) {
  const evs = [];
  for (const [iso, entries] of Object.entries(plan.weeks || {})) {
    const mon = isoToTs(iso);
    for (const e of entries) if (isSelected(e, plan.sel)) evs.push(toEvent(e, mon));
  }
  evs.sort((a, b) => a.start - b.start || a.end - b.end);
  return evs;
}
async function fetchWeek(plan, iso) {
  const jobs = [fetchPlanText(urls.week(plan.src.kod, plan.src.cdyd, iso)).then(parsePlan)];
  // dodatkowe przedmioty spoza planu kierunku (np. lektorat, UBZO)
  for (const x of plan.extras || []) jobs.push(fetchPlanText(urls.subjectWeek(x.kod, plan.src.cdyd, iso)).then(parsePlan));
  const parts = await Promise.all(jobs);
  const seen = new Set();
  const entries = [];
  for (const e of parts.flat()) {
    const k = `${e.compId}|${e.group}|${e.dayIndex}|${e.startMin}`;
    if (!seen.has(k)) { seen.add(k); entries.push(e); }
  }
  plan.weeks = plan.weeks || {};
  plan.weeks[iso] = entries;
}
function weeksToRefresh(extraTs) {
  const set = new Set();
  const now = Date.now();
  for (let i = 0; i < WEEKS_AHEAD; i++) set.add(mondayISO(now + i * 7 * DAY));
  if (extraTs) set.add(mondayISO(extraTs));
  return [...set];
}
const weekLoading = new Set();
const weekFailed = new Map();
async function ensureWeek(plan, ts) {
  if (!plan || plan.kind !== 'usos' || !plan.src) return;
  const iso = mondayISO(ts);
  if ((plan.weeks && plan.weeks[iso]) || weekLoading.has(iso)) return;
  if (Date.now() - (weekFailed.get(iso) || 0) < 60000) return;
  weekLoading.add(iso); renderTop();
  try {
    await fetchWeek(plan, iso);
    plan.events = rebuildUsosEvents(plan);
    save();
  } catch (e) { weekFailed.set(iso, Date.now()); toast(e.message || String(e)); }
  finally { weekLoading.delete(iso); render(); }
}

async function refreshPlan(plan, { quiet = false } = {}) {
  let changed = 0;
  let events;
  if (plan.kind === 'usos') {
    const isos = weeksToRefresh(selDate);
    await Promise.all(isos.map((iso) => fetchWeek(plan, iso)));
    // stare tygodnie (sprzed ponad 2 tygodni) wyrzucamy, żeby nie puchło
    const keepFrom = isoToTs(mondayISO(Date.now() - 14 * DAY));
    for (const iso of Object.keys(plan.weeks)) if (isoToTs(iso) < keepFrom) delete plan.weeks[iso];
    events = rebuildUsosEvents(plan);
  } else {
    const text = await fetchPlanText(plan.url);
    events = parseICS(text);
  }
  if (plan.skipDiff) delete plan.skipDiff;
  else if (plan.events && plan.fetchedAt) {
    const items = diffEvents(plan.events, events, Date.now());
    if (items.length) {
      plan.changes = { at: Date.now(), items };
      plan.changesUnseen = true;
      changed = items.length;
      if (!quiet) toast(`Plan się zmienił (${items.length}) — zobacz zakładkę Zmiany`);
    }
  }
  plan.events = events;
  plan.fetchedAt = Date.now();
  plan.error = null;
  return changed;
}

async function refreshActive({ manual = false } = {}) {
  const plan = activePlan();
  if (!plan || refreshing) return;
  refreshing = true; renderTop();
  if (plan.kind === 'merge') {
    let changed = 0;
    const errs = [];
    for (const p of planSources(plan)) {
      try { changed += await refreshPlan(p, { quiet: true }); } catch (e) { p.error = e.message || String(e); errs.push(`${p.name}: ${p.error}`); }
    }
    plan.fetchedAt = Date.now();
    plan.error = errs.length ? errs.join(' · ') : null;
    refreshing = false; save(); render();
    if (changed) toast(`Plan się zmienił (${changed}) — zobacz zakładkę Zmiany`);
    else if (manual) toast(errs.length ? plan.error : 'Plany odświeżone — bez zmian');
    return;
  }
  try {
    const changed = await refreshPlan(plan);
    if (manual && !changed) toast('Plan odświeżony — bez zmian');
  } catch (e) {
    plan.error = e.message || String(e);
    logError(`odświeżanie ${plan.kind || 'ical'}: ${plan.error}`);
    if (manual) toast(plan.error);
  } finally {
    refreshing = false; save(); render();
  }
}

function maybeAutoRefresh() {
  const plan = activePlan();
  if (!plan) return;
  const stale = (p) => !p.fetchedAt || Date.now() - p.fetchedAt > AUTO_REFRESH_MS;
  if (plan.kind === 'merge' ? planSources(plan).some(stale) || stale(plan) : stale(plan)) refreshActive();
}

// ---------- render ----------
function render() {
  evMemo = null;
  document.body.classList.toggle('editing', editMode);
  $('editBar').hidden = !editMode || !activePlan();
  renderTop(); renderContent();
  const plan = activePlan();
  if (plan) for (const p of planSources(plan)) ensureWeek(p, selDate);
}

function renderTop() {
  const plan = activePlan();
  $('planName').textContent = plan ? plan.name : 'Plan zajęć';
  $('refreshBtn').classList.toggle('spin', refreshing);
  $('refreshBtn').hidden = !plan;
  const st = $('status');
  st.classList.remove('err');
  if (!plan) st.textContent = '';
  else if (refreshing) st.textContent = 'Odświeżanie…';
  else if (weekLoading.size) st.textContent = 'Pobieranie tygodnia…';
  else if (plan.error) { st.textContent = `⚠ ${plan.error}` + (plan.fetchedAt ? ` · dane z ${ago(plan.fetchedAt)}` : ''); st.classList.add('err'); }
  else if (plan.fetchedAt) st.textContent = `Zaktualizowano ${ago(plan.fetchedAt)}`;
  else st.textContent = '';

  const hasPlan = !!plan;
  $('navRow').hidden = !hasPlan || state.view === 'changes';
  $('tabs').hidden = !hasPlan;
  $('weekStrip').hidden = !hasPlan || state.view !== 'day';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === state.view));
  const badge = $('changesBadge');
  const n = plan ? planSources(plan).reduce((a, p) => a + (p.changesUnseen ? p.changes?.items?.length || 0 : 0), 0) : 0;
  badge.hidden = !n; badge.textContent = n;

  if (state.view === 'week') {
    const ws = startOfWeek(selDate);
    $('dateLabel').textContent = `${fmtShort(ws)} – ${fmtShort(addDays(ws, 6))}`;
  } else {
    const t = startOfDay(Date.now());
    const prefix = selDate === t ? 'Dziś, ' : selDate === addDays(t, 1) ? 'Jutro, ' : selDate === addDays(t, -1) ? 'Wczoraj, ' : '';
    $('dateLabel').textContent = prefix ? prefix + fmtDay(selDate) : cap(fmtDay(selDate));
  }
  if (hasPlan && state.view === 'day') renderWeekStrip(plan);
}

function renderWeekStrip(plan) {
  const ws = startOfWeek(selDate);
  const today = startOfDay(Date.now());
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const n = eventsOn(plan, d).length;
    const dots = '<i></i>'.repeat(Math.min(n, 5));
    html += `<button class="ws-day${d === selDate ? ' sel' : ''}${d === today ? ' today' : ''}" data-day="${d}">
      <span>${esc(wdShort(d))}</span><b>${new Date(d).getDate()}</b><span class="ws-dots">${dots}</span></button>`;
  }
  $('weekStrip').innerHTML = html;
}

function renderContent() {
  const plan = activePlan();
  const c = $('content');
  if (!plan) { c.innerHTML = emptyNoPlans(); return; }
  reg = [];
  if (!planReady(plan)) {
    if (plan.kind === 'merge') { c.innerHTML = '<div class="empty"><div class="big">⏳</div><h2>Pobieranie planów…</h2></div>'; return; }
    c.innerHTML = plan.error
      ? `<div class="empty"><div class="big">⚠</div><h2>Nie udało się pobrać planu</h2><p>${esc(plan.error)}</p><button class="btn" data-act="refresh">Spróbuj ponownie</button></div>`
      : `<div class="empty"><div class="big">⏳</div><h2>Pobieranie planu…</h2></div>`;
    return;
  }
  if (plan.kind === 'usos' && state.view !== 'changes' && !(plan.weeks && plan.weeks[mondayISO(selDate)])) {
    const failed = Date.now() - (weekFailed.get(mondayISO(selDate)) || 0) < 60000;
    c.innerHTML = failed
      ? `<div class="empty"><div class="big">⚠</div><h2>Nie udało się pobrać tego tygodnia</h2><p>Sprawdź internet i spróbuj za chwilę.</p></div>`
      : `<div class="empty"><div class="big">⏳</div><h2>Pobieram ten tydzień…</h2></div>`;
    return;
  }
  if (state.view === 'week') c.innerHTML = weekSwitch() + ((state.settings?.weekStyle || 'grid') === 'grid' ? weekGrid(plan) : weekView(plan));
  else if (state.view === 'changes') c.innerHTML = changesView(plan);
  else c.innerHTML = dayView(plan);
}

function emptyNoPlans() {
  return `<div class="empty">
    <div class="big">📅</div>
    <h2>Dodaj swój pierwszy plan</h2>
    <p>Wybierz swój kierunek i grupy z listy (albo wklej link z USOSweb), a apka będzie sama pilnować aktualnego planu.</p>
    <button class="btn" data-act="add">+ Dodaj plan</button>
  </div>`;
}

function helpBox() {
  return `<div class="help"><b>Skąd wziąć link?</b>
    <ol>
      <li>Wejdź na <b>usosweb.polsl.pl</b> i zaloguj się.</li>
      <li><b>Mój USOSweb → Plan zajęć</b>.</li>
      <li>Po prawej kliknij <b>eksportuj</b> (lub „wyślij komuś ten plan”).</li>
      <li>Skopiuj link do kalendarza (iCal / .ics) i wklej go tutaj.</li>
    </ol>
    Możesz dodać kilka planów (np. swój i kolegi albo inną grupę) i przełączać je u góry.</div>`;
}

const PIN = '<svg class="pin" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="9.5" r="2.4" fill="currentColor"/></svg>';
let cardNo = 0;
function eventCard(ev, now) {
  const { type, title } = splitTitle(ev);
  const past = ev.end <= now;
  const isNow = ev.start <= now && now < ev.end;
  const prog = isNow ? ((now - ev.start) / (ev.end - ev.start)) * 100 : 0;
  const right = isNow
    ? `<span class="now-tag">teraz · do końca ${dur(ev.end - now)}</span>`
    : !past && ev.start - now < 3 * 3600000 ? `<span>za ${dur(ev.start - now)}</span>` : `<span>${dur(ev.end - ev.start)}</span>`;
  const desc = ev.description && ev.description !== ev.summary ? `<div class="desc">${esc(ev.description)}</div>` : '';
  cardNo += 1;
  return `<div class="card t-${type.key}${past ? ' past' : ''}${isNow ? ' now' : ''}${ev.hidden ? ' hidden-ev' : ''}${ev.edited || ev.custom ? ' edited' : ''}" style="--c: ${colorOf(ev, type)}" data-act="toggle" data-i="${regEv(ev)}">
    <div class="card-no">DET. ${String(cardNo).padStart(2, '0')} · ${esc(type.label.toUpperCase())}</div>
    <div class="time"><span><b>${ev.allDay ? 'cały dzień' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`}</b></span>${right}</div>
    <div class="title">${esc(title)}</div>
    <div class="meta"><span class="type-pill">${esc(type.label)}</span>${ev.location ? `<span class="loc">${PIN}${esc(ev.location)}</span>` : ''}${srcTag(ev)}${ev.hidden ? '<span class="ed-tag">ukryte</span>' : ev.custom ? '<span class="ed-tag">✎ Twoje</span>' : ev.edited ? '<span class="ed-tag">✎ zmienione</span>' : ''}</div>
    ${ev.allDay ? '' : `<div class="big-time"><b>${fmtTime(ev.start)}</b><span>–${fmtTime(ev.end)}</span></div>`}
    ${desc}
    ${isNow ? `<div class="progress" style="width:${prog.toFixed(1)}%"></div>` : ''}
  </div>`;
}

function dayView(plan) {
  cardNo = 0;
  const evs = eventsOn(plan, selDate);
  const now = Date.now();
  if (!evs.length) {
    const next = viewEvents(plan).find((e) => e.start >= addDays(selDate, 1));
    return `<div class="empty"><div class="big">☕</div><h2>Wolne</h2>
      ${next ? `<p>Najbliższe zajęcia: <b>${esc(fmtDay(next.start))}</b>, ${fmtTime(next.start)}</p><button class="btn ghost" data-act="goto" data-day="${startOfDay(next.start)}">Przejdź</button>` : '<p>Brak kolejnych zajęć w planie.</p>'}
    </div>`;
  }
  let html = '';
  let lastEnd = null;
  for (const ev of evs) {
    if (lastEnd !== null && ev.start - lastEnd >= 15 * 60000) {
      html += `<div class="gap"><span>okienko ${dur(ev.start - lastEnd)}</span></div>`;
    }
    html += eventCard(ev, now);
    lastEnd = Math.max(lastEnd ?? 0, ev.end);
  }
  const first = evs[0];
  const last = evs[evs.length - 1];
  html += `<p class="hint day-sum">${evs.length} ${zajec(evs.length)} · ${first.allDay ? '' : `${fmtTime(first.start)}–${fmtTime(last.end)}`}</p>`;
  html += titleBlock(plan, evs);
  return html;
}

// ---------- tydzień jako siatka (dni × godziny) ----------
const HOUR_PX = 58;
let gridDays = [];
let gridMinH = 8;
function weekSwitch() {
  const g = (state.settings?.weekStyle || 'grid') === 'grid';
  return `<div class="wswitch"><button class="${g ? 'on' : ''}" data-act="week-style" data-style="grid">Siatka</button><button class="${g ? '' : 'on'}" data-act="week-style" data-style="list">Lista</button></div>`;
}
// „General mechanics” -> „Gm”, „Gas dynamics” -> „Gd”, krótkie nazwy zostają w całości
function abbrev(name) {
  const clean = name.replace(/\([^)]*\)/g, ' ').trim();
  if (clean.length <= 9) return clean;
  const words = clean.split(/[\s\-–—,/]+/).filter((w) => /\p{L}/u.test(w));
  if (words.length < 2) return clean.slice(0, 8);
  return words.map((w, i) => (i ? w[0].toLowerCase() : w[0].toUpperCase())).join('');
}
// rozkład nachodzących na siebie zajęć obok siebie
function lanes(evs) {
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const laneEnds = [];
    for (const e of cluster) {
      let l = laneEnds.findIndex((end) => end <= e.start);
      if (l < 0) { l = laneEnds.length; laneEnds.push(0); }
      laneEnds[l] = e.end;
      out.push({ e, lane: l });
    }
    const n = laneEnds.length;
    for (let i = out.length - cluster.length; i < out.length; i++) out[i].n = n;
    cluster = [];
  };
  for (const e of evs) {
    if (e.start >= clusterEnd && cluster.length) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  if (cluster.length) flush();
  return out;
}
function weekGrid(plan) {
  const ws = startOfWeek(selDate);
  const today = startOfDay(Date.now());
  const now = Date.now();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const evs = eventsOn(plan, d).filter((e) => !e.allDay);
    if (i < 5 || evs.length || state.settings?.weekends) days.push({ d, evs });
  }
  const all = days.flatMap((x) => x.evs);
  const hourOf = (ts) => { const t = new Date(ts); return t.getHours() + t.getMinutes() / 60; };
  let minH = 8;
  let maxH = 16;
  for (const e of all) { minH = Math.min(minH, Math.floor(hourOf(e.start))); maxH = Math.max(maxH, Math.ceil(hourOf(e.end) || 24)); }
  const hours = maxH - minH;
  gridDays = days.map((x) => x.d);
  gridMinH = minH;
  let head = '<div class="wg-corner"></div>';
  let cols = '';
  days.forEach(({ d, evs }, col) => {
    head += `<button class="wg-dh${d === today ? ' today' : ''}" data-act="goto" data-day="${d}"><small>${esc(wdShort(d))}</small><b>${new Date(d).getDate()}</b></button>`;
    let blocks = '';
    for (const { e, lane, n } of lanes(evs)) {
      const top = (hourOf(e.start) - minH) * HOUR_PX;
      const h = Math.max(18, (hourOf(e.end) - hourOf(e.start)) * HOUR_PX - 2);
      const { type, title } = splitTitle(e);
      const idx = regEv(e);
      const room = (e.location || '').split(' · ')[0];
      const cls = `wg-ev t-${type.key}${e.end <= now ? ' past' : ''}${e.start <= now && now < e.end ? ' now' : ''}${e.hidden ? ' hidden-ev' : ''}${e.edited || e.custom ? ' edited' : ''}${e.srcColor ? ' src' : ''}${n > 1 ? ' narrow' : ''}`;
      blocks += `<button class="${cls}" data-act="ev" data-i="${idx}" data-col="${col}" style="--c: ${colorOf(e, type)}; --s: ${e.srcColor || 'transparent'}; top:${top.toFixed(1)}px; height:${h.toFixed(1)}px; left:calc(${(lane / n) * 100}% + 1px); width:calc(${100 / n}% - 2px)">
        <b>${esc(abbrev(title))}</b>${h > 40 && n < 3 ? `<small>${esc(type.code)}${room ? ` · ${esc(room)}` : ''}</small>` : ''}</button>`;
    }
    let nowLine = '';
    if (d === today) {
      const nh = hourOf(now);
      if (nh >= minH && nh <= maxH) nowLine = `<div class="wg-now" style="top:${((nh - minH) * HOUR_PX).toFixed(1)}px"></div>`;
    }
    cols += `<div class="wg-col${d === today ? ' today' : ''}">${blocks}${nowLine}</div>`;
  });
  let labels = '';
  let lines = '';
  for (let hh = 0; hh <= hours; hh++) {
    labels += `<span style="top:${hh * HOUR_PX}px">${String(minH + hh).padStart(2, '0')}</span>`;
    lines += `<i style="top:${hh * HOUR_PX}px"></i>`;
  }
  const nl = days.length;
  return `<div class="wg" style="--cols:${nl}">
    <div class="wg-head">${head}</div>
    <div class="wg-body" style="height:${hours * HOUR_PX}px">
      <div class="wg-hours">${labels}</div>
      <div class="wg-lines">${lines}</div>
      <div class="wg-cols">${cols}</div>
    </div>
  </div>`;
}
function eventSheet(e) {
  const { title } = splitTitle(e);
  cardNo = 0;
  openSheet(`<h3>${esc(title)}</h3><p class="hint">${esc(cap(fmtDay(e.start)))}</p>
    <div class="sheet-card">${eventCard(e, Date.now()).replace('class="card', 'class="card open')}</div>
    <div class="row" style="margin-top:8px"><button class="btn ghost" data-act="goto" data-day="${startOfDay(e.start)}">Pokaż ten dzień</button>
    <button class="btn ghost" data-act="ev-edit" data-i="${reg.indexOf(e)}">Edytuj</button></div>`);
}

// Tabelka rysunkowa (widoczna tylko w motywie Blueprint)
function isoWeek(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / DAY - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
function titleBlock(plan, evs) {
  const wk = isoWeek(selDate);
  const src = plan.kind === 'usos' ? plan.src : null;
  const sem = src ? (/(\d+)\s*semestr/.exec(src.nazwa || '') || [])[1] : '';
  const cell = (k, v) => `<div><small>${k}</small><b>${esc(v)}</b></div>`;
  const first = evs[0];
  const last = evs[evs.length - 1];
  return `<div class="tblock">
    ${cell('PLAN', (plan.name || '').toUpperCase().slice(0, 22))}
    ${cell('SEMESTR', sem ? `${sem} · ${src.cdyd && /-L$/.test(src.cdyd) ? 'LATO' : 'ZIMA'}` : '—')}
    ${cell('TYDZIEŃ', `${wk} · ${wk % 2 ? 'NIEPARZ.' : 'PARZ.'}`)}
    ${cell('SKALA', '1 : 1')}
    ${cell('ŹRÓDŁO', plan.kind === 'usos' ? 'USOSWEB' : plan.kind === 'merge' ? 'POŁĄCZONY' : 'ICAL')}
    ${cell('ZAJĘCIA', `${evs.length} SZT.`)}
    ${cell('ZAKRES', first && !first.allDay ? `${fmtTime(first.start)}–${fmtTime(last.end)}` : '—')}
    ${cell('REW.', 'A')}
  </div>`;
}

function weekView(plan) {
  const ws = startOfWeek(selDate);
  const today = startOfDay(Date.now());
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const evs = eventsOn(plan, d);
    if (!evs.length && i >= 5 && !state.settings?.weekends) continue; // pusty weekend pomijamy
    html += `<div class="day-head${d === today ? ' today' : ''}" data-act="goto" data-day="${d}">
      <span>${esc(cap(fmtDay(d)))}</span><small>${evs.length ? `${fmtTime(evs[0].start)}–${fmtTime(evs[evs.length - 1].end)}` : 'wolne'}</small></div>`;
    for (const ev of evs) {
      const { type, title } = splitTitle(ev);
      html += `<div class="compact${ev.hidden ? ' hidden-ev' : ''}" style="--c: ${colorOf(ev, type)}" data-act="toggle" data-i="${regEv(ev)}">
        <div class="t">${fmtTime(ev.start)}–${fmtTime(ev.end)}<br><span class="type-pill">${esc(type.code)}</span></div>
        <div><div class="n">${esc(title)}</div>${ev.location ? `<div class="l">${esc(ev.location)}</div>` : ''}${ev.srcName ? `<div class="l">${srcTag(ev)}</div>` : ''}</div>
      </div>`;
    }
  }
  return html || '<div class="empty"><div class="big">☕</div><h2>Wolny tydzień</h2></div>';
}

function changesView(plan) {
  if (plan.kind === 'merge') {
    const parts = planSources(plan).map((p) => `<div class="list-head">${esc(p.name)}</div>${changesView(p)}`);
    return parts.join('') || '<div class="empty"><h2>Bez zmian</h2></div>';
  }
  const E = plan.edits || {};
  const mine = (e) => e && ((E.occ || {})[occKey(e)] || (E.series || {})[seriesKey(e)]);
  const ch = plan.changes;
  if (plan.changesUnseen) { plan.changesUnseen = false; save(); setTimeout(renderTop, 0); }
  if (!ch || !ch.items.length) {
    return `<div class="empty"><div class="big">✓</div><h2>Bez zmian</h2>
      <p>Gdy przy odświeżeniu coś się zmieni w planie (sala, godzina, nowe albo odwołane zajęcia), zobaczysz to tutaj.</p></div>`;
  }
  const line = (e) => `${fmtDateTime(e.start)}–${fmtTime(e.end)}${e.location ? ` · ${esc(e.location)}` : ''}`;
  let html = `<p class="hint">Zmiany wykryte ${esc(ago(ch.at))} (dotyczą nadchodzących zajęć).</p>`;
  for (const c of ch.items) {
    const ev = c.after || c.before;
    const { title } = splitTitle(ev);
    let k, d;
    if (c.type === 'added') { k = 'Nowe zajęcia'; d = line(c.after); }
    else if (c.type === 'removed') { k = 'Usunięte / odwołane'; d = `<s>${line(c.before)}</s>`; }
    else if (c.type === 'moved') { k = 'Przeniesione'; d = `<s>${line(c.before)}</s><br>→ ${line(c.after)}`; }
    else { k = 'Zmiana sali'; d = `${fmtDateTime(ev.start)} · <s>${esc(c.before.location || 'brak')}</s> → ${esc(c.after.location || 'brak')}`; }
    const conflict = mine(c.before) || mine(c.after) ? '<div class="d conflict">✎ Masz własną zmianę tych zajęć — zostaje Twoja wersja. Możesz ją cofnąć w trybie edycji.</div>' : '';
    html += `<div class="change ${c.type}"><div class="k">${k}</div><div class="n">${esc(title)}</div><div class="d">${d}</div>${conflict}</div>`;
  }
  return html;
}

// ---------- arkusze (wybór planu, formularz) ----------
let sheetOpen = false;
function openSheet(html) {
  $('sheet').innerHTML = `<div class="grab"></div>${html}`;
  $('sheet').hidden = false; $('sheetBackdrop').hidden = false;
  if (!sheetOpen) { sheetOpen = true; try { history.pushState({ sheet: 1 }, ''); } catch (e) { /* */ } }
}
function closeSheet(fromPop = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('sheet').onclick = null;
  $('sheet').hidden = true; $('sheetBackdrop').hidden = true;
  if (!fromPop) { try { history.back(); } catch (e) { /* */ } }
}
window.addEventListener('popstate', () => closeSheet(true));

function plansSheet() {
  const act = activePlan();
  let html = '<h3>Twoje plany</h3>';
  if (!state.plans.length) html += '<p class="hint">Nie masz jeszcze żadnego planu.</p>';
  for (const p of state.plans) {
    const sub = p.kind === 'merge' ? `połączony: ${planSources(p).map((x) => x.name).join(' + ')}` : p.error ? `⚠ ${p.error}` : p.fetchedAt ? `${(p.events || []).length} ${zajec((p.events || []).length)} · ${ago(p.fetchedAt)}` : 'jeszcze nie pobrany';
    html += `<div class="plan-item${act && p.id === act.id ? ' on' : ''}" data-act="pick" data-id="${p.id}">
      <div class="pi-main"><div class="pi-name">${esc(p.name)}</div><div class="pi-sub">${esc(sub)}</div></div>
      <button class="edit" data-act="edit" data-id="${p.id}">Edytuj</button></div>`;
  }
  html += '<button class="btn block" data-act="add" style="margin-top:6px">+ Dodaj plan</button>';
  openSheet(html);
}

function formSheet(plan) {
  const editing = !!plan;
  openSheet(`<h3>${editing ? 'Edytuj plan' : 'Nowy plan'}</h3>
    <form id="planForm" autocomplete="off">
      <label class="field"><span>Nazwa (np. „Mój plan”, „Grupa 2”)</span>
        <input name="name" required maxlength="40" value="${esc(plan?.name || '')}" placeholder="Mój plan"></label>
      <label class="field"><span>Link do planu (iCal / .ics z USOSweb)</span>
        <input name="url" required inputmode="url" value="${esc(plan?.url || '')}" placeholder="https://…"></label>
      <div class="err-box" id="formErr" hidden></div>
      <div class="row">
        <button type="submit" class="btn" id="saveBtn">${editing ? 'Zapisz' : 'Dodaj'}</button>
        <button type="button" class="btn ghost" data-act="close">Anuluj</button>
      </div>
      <button type="button" class="btn ghost block" id="forceBtn" hidden style="margin-top:8px">Zapisz bez sprawdzania</button>
      ${editing ? `<button type="button" class="btn danger block" data-act="delete" data-id="${plan.id}" style="margin-top:8px">Usuń ten plan</button>` : ''}
    </form>${helpBox()}`);

  const form = $('planForm');
  const submit = async (force) => {
    const name = form.name.value.trim();
    const url = normalizeUrl(form.url.value);
    const err = $('formErr');
    err.hidden = true;
    if (!name || !url) return;
    if (!/^https?:\/\//i.test(url)) { err.textContent = 'Link musi zaczynać się od https://'; err.hidden = false; return; }
    const target = plan || { id: uid() };
    const urlChanged = target.url !== url;
    target.name = name; target.url = url;
    if (urlChanged) { target.events = null; target.fetchedAt = null; target.changes = null; target.changesUnseen = false; }
    if (!force && urlChanged) {
      $('saveBtn').disabled = true; $('saveBtn').textContent = 'Sprawdzam…';
      try {
        await refreshPlan(target, { quiet: true });
      } catch (e) {
        err.textContent = `Nie udało się pobrać planu: ${e.message}`;
        err.hidden = false; $('forceBtn').hidden = false;
        $('saveBtn').disabled = false; $('saveBtn').textContent = editing ? 'Zapisz' : 'Dodaj';
        return;
      }
    }
    if (!plan) state.plans.push(target);
    state.activeId = target.id;
    save(); closeSheet(); render();
    if (!target.events) refreshActive();
    else toast(editing ? 'Zapisano' : `Dodano plan „${name}” (${target.events.length} ${zajec(target.events.length)})`);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
  $('forceBtn').addEventListener('click', () => submit(true));
  setTimeout(() => { if (!editing) form.name.focus(); }, 50);
}

// ---------- edycja planu ----------
function planEdits(plan) {
  if (!plan.edits) plan.edits = emptyEdits();
  plan.edits.occ = plan.edits.occ || {};
  plan.edits.series = plan.edits.series || {};
  plan.edits.custom = plan.edits.custom || [];
  return plan.edits;
}
function setEditMode(on) {
  editMode = on;
  if (on && state.view === 'changes') state.view = 'day';
  render();
  if (on) toast(state.view === 'week' ? 'Przeciągnij blok albo go dotknij, żeby edytować' : 'Dotknij zajęcia, żeby je edytować');
}
const typeOptions = (sel) => TYPES.map((t) => `<option value="${t.key}"${t.key === sel ? ' selected' : ''}>${esc(t.label)}</option>`).join('');

// formularz edycji / dodawania. ev = zajęcia z widoku (null = nowe)
function editSheet(ev) {
  const plan = activePlan();
  if (!plan) return;
  const isNew = !ev;
  const orig = ev ? (ev.orig || ev) : null;
  const custom = ev && ev.custom ? planEdits(plan).custom.find((c) => c.id === ev.cid) : null;
  const t = ev ? splitTitle(ev).type : typeByKey('inne');
  const dayTs = ev ? startOfDay(ev.start) : selDate;
  const sMin = ev ? minutesOf(ev.start) : 10 * 60;
  const eMin = ev ? minutesOf(ev.end) : 11 * 60 + 30;
  const weeklyScope = !isNew && !(custom && !custom.weekly);
  const defScope = ev && ev.edited && ev.editScope === 'occ' ? 'occ' : 'series';
  openSheet(`<h3>${isNew ? 'Dodaj zajęcia' : 'Edytuj zajęcia'}</h3>
    <form id="edForm" autocomplete="off">
      <label class="field"><span>Nazwa</span><input name="summary" maxlength="80" required value="${esc(ev ? ev.summary : '')}" placeholder="np. Lektorat — angielski"></label>
      <div class="row">
        <label class="field"><span>Rodzaj</span><select name="typeKey">${typeOptions(t.key === 'inne' && isNew ? 'lek' : t.key)}</select></label>
        <label class="field"><span>Sala</span><input name="location" maxlength="60" value="${esc(ev ? ev.location : '')}" placeholder="np. 3.14"></label>
      </div>
      <label class="field"><span>Dzień</span><input type="date" name="date" required value="${isoDate(dayTs)}"></label>
      <div class="row">
        <label class="field"><span>Od</span><input type="time" name="start" required step="300" value="${fmtMin(sMin)}"></label>
        <label class="field"><span>Do</span><input type="time" name="end" required step="300" value="${fmtMin(eMin)}"></label>
      </div>
      ${isNew ? `<label class="switch-row"><span>Powtarzaj co tydzień (15 tygodni)</span><input type="checkbox" name="weekly" checked></label>` : ''}
      ${weeklyScope ? `<div class="scope"><div class="list-head">Zastosuj do</div>
        <label class="radio-row"><input type="radio" name="scope" value="occ"${defScope === 'occ' ? ' checked' : ''}><span>Tylko te zajęcia (${esc(fmtShort(dayTs))})</span></label>
        <label class="radio-row"><input type="radio" name="scope" value="series"${defScope === 'series' ? ' checked' : ''}><span>Co tydzień</span></label></div>` : ''}
      <div class="err-box" id="edErr" hidden></div>
      <div class="sheet-actions"><button type="submit" class="btn">${isNew ? 'Dodaj' : 'Zapisz'}</button><button type="button" class="btn ghost" data-act="close">Anuluj</button></div>
      ${isNew ? '' : `<div class="row" style="margin-top:8px">
        ${ev.custom ? '<button type="button" class="btn danger" id="edDelete">Usuń</button>' : `<button type="button" class="btn ghost" id="edHide">${ev.hidden ? 'Pokaż z powrotem' : 'Ukryj (odwołane)'}</button>`}
        ${ev.edited ? '<button type="button" class="btn ghost" id="edRestore">Przywróć oryginał</button>' : ''}</div>`}
    </form>`);
  const f = $('edForm');
  const scope = () => (f.scope ? [...f.scope].find((r) => r.checked)?.value || 'series' : 'series');
  const finish = (msg) => { save(); closeSheet(); render(); toast(msg); };
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = {
      summary: f.summary.value.trim(), typeKey: f.typeKey.value, location: f.location.value.trim(),
      dayTs: dateTs(f.date.value), startMin: parseMin(f.start.value), endMin: parseMin(f.end.value),
    };
    if (v.startMin == null || v.endMin == null || v.endMin <= v.startMin) { $('edErr').textContent = 'Godzina końca musi być po godzinie początku.'; $('edErr').hidden = false; return; }
    const E = planEdits(plan);
    if (isNew) {
      E.custom.push({ id: uid(), summary: v.summary, typeKey: v.typeKey, location: v.location, date: f.date.value, startMin: v.startMin, endMin: v.endMin, weekly: !!f.weekly?.checked, until: isoDate(addDays(v.dayTs, 7 * 15)) });
      selDate = startOfDay(v.dayTs);
      finish('Dodano zajęcia');
      return;
    }
    if (custom && (!custom.weekly || scope() === 'series')) {
      // własne zajęcia: zmiana definicji (cała seria albo pojedyncze)
      const shift = Math.round((startOfDay(v.dayTs) - startOfDay(orig.start)) / DAY);
      Object.assign(custom, { summary: v.summary, typeKey: v.typeKey, location: v.location, startMin: v.startMin, endMin: v.endMin, date: isoDate(addDays(dateTs(custom.date), shift)) });
      finish('Zapisano');
      return;
    }
    const patch = makePatch(orig, { ...v, origTypeKey: classType(orig).key });
    if (scope() === 'occ') E.occ[ev.okey] = patch;
    else { E.series[ev.skey] = patch; delete E.occ[ev.okey]; }
    finish(scope() === 'occ' ? 'Zmienione tylko te zajęcia' : 'Zmienione co tydzień');
  });
  $('edDelete')?.addEventListener('click', () => {
    const E = planEdits(plan);
    if (custom.weekly && scope() === 'occ') E.occ[ev.okey] = { hidden: true };
    else E.custom = E.custom.filter((c) => c.id !== custom.id);
    finish('Usunięto');
  });
  $('edHide')?.addEventListener('click', () => {
    const E = planEdits(plan);
    const key = scope() === 'occ' ? 'occ' : 'series';
    const k = key === 'occ' ? ev.okey : ev.skey;
    const cur = { ...(E[key][k] || {}) };
    if (ev.hidden) {
      delete cur.hidden;
      // ukrycie mogło być zapisane w drugiej warstwie
      for (const [L, kk] of [['occ', ev.okey], ['series', ev.skey]]) if (E[L][kk]) delete E[L][kk].hidden;
    } else cur.hidden = true;
    if (Object.keys(cur).length) E[key][k] = cur; else delete E[key][k];
    for (const [L, kk] of [['occ', ev.okey], ['series', ev.skey]]) if (E[L][kk] && !Object.keys(E[L][kk]).length) delete E[L][kk];
    finish(ev.hidden ? 'Zajęcia znów widoczne' : 'Ukryte — w trybie edycji możesz je przywrócić');
  });
  $('edRestore')?.addEventListener('click', () => {
    const E = planEdits(plan);
    delete E.occ[ev.okey]; delete E.series[ev.skey];
    finish('Przywrócono oryginał');
  });
}

// „+ Dodaj” w trybie edycji: własne zajęcia albo przedmiot z USOS
function addChoiceSheet() {
  const plan = activePlan();
  if (plan?.kind !== 'usos') { editSheet(null); return; }
  openSheet(`<h3>Dodaj</h3>
    <button class="choice" data-act="add-subject"><b>Przedmiot z USOS</b><span>Np. lektorat albo UBZO — wyszukasz go i wybierzesz grupę, a plan sam będzie się aktualizował.</span></button>
    <button class="choice" data-act="add-own"><b>Własne zajęcia</b><span>Wpiszesz nazwę, dzień i godziny ręcznie.</span></button>
    ${(plan.extras || []).length ? `<div class="list-head">Dodane przedmioty z USOS</div>${plan.extras.map((x, i) => `<div class="plan-item"><div class="pi-main"><div class="pi-name">${esc(x.nazwa)}</div><div class="pi-sub">${esc(x.kod)}</div></div><button class="edit" data-act="rm-extra" data-i="${i}">Usuń</button></div>`).join('')}` : ''}`);
}

function subjectSearchSheet() {
  const plan = activePlan();
  openSheet(`<h3>Przedmiot z USOS</h3>
    <form id="ssForm"><label class="field"><span>Nazwa przedmiotu (z USOS-a albo z rejestracji)</span>
      <input id="ssQ" placeholder="np. język angielski, UBZO, nazwa przedmiotu" autocomplete="off"></label>
      <button class="btn block" type="submit">Szukaj</button></form>
    <div id="ssList"><p class="hint">Lektorat i przedmioty UBZO wybiera się indywidualnie, więc wyszukaj ten, na który jesteś zapisany. Pełną nazwę zobaczysz w USOSweb → Mój USOSweb → Plan zajęć albo w rejestracji.</p></div>`);
  $('ssForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('ssQ').value.trim();
    if (q.length < 3) return;
    $('ssList').innerHTML = '<p class="hint">Szukam…</p>';
    try {
      const list = parseSubjects(await fetchPlanText(urls.subjectSearch(q)));
      $('ssList').innerHTML = list.length
        ? list.map((x) => `<button class="list-item" data-act="pick-subject" data-kod="${esc(x.kod)}" data-nazwa="${esc(x.nazwa)}">${esc(x.nazwa)}<small>${esc(x.jedn)} · ${esc(x.kod)}</small></button>`).join('') + (list.length >= 30 ? '<p class="hint">Pokazuję pierwsze 30 — doprecyzuj nazwę, jeśli nie widzisz swojego.</p>' : '')
        : '<p class="hint">Nic nie znaleziono. Spróbuj krótszej albo innej nazwy.</p>';
    } catch (err) { $('ssList').innerHTML = `<p class="err-box">${esc(err.message)}</p>`; }
  });
  setTimeout(() => $('ssQ')?.focus(), 50);
}

async function subjectGroupSheet(kod, nazwa) {
  const plan = activePlan();
  openSheet(`<h3>${esc(nazwa)}</h3><div class="empty"><div class="big">⏳</div><p>Pobieram plan przedmiotu…</p></div>`);
  let comps;
  try {
    comps = components(parsePlan(await fetchPlanText(urls.subjectSemester(kod, plan.src.cdyd))));
    if (!comps.length) throw new Error('Ten przedmiot nie ma zajęć w planie na ten semestr.');
  } catch (err) {
    openSheet(`<h3>${esc(nazwa)}</h3><div class="empty"><div class="big">⚠</div><p>${esc(err.message)}</p><button class="btn ghost" data-act="add-subject">Szukaj innego</button></div>`);
    return;
  }
  if (!sheetOpen) return;
  const sel = {};
  const draw = () => {
    let html = `<h3>${esc(nazwa)}</h3><p class="hint">Wybierz swoją grupę przy każdych zajęciach. „Pomiń” — nie dodawaj tych zajęć.</p>`;
    for (const c of comps) {
      const opts = [...c.groups.map((g) => g.group), 'skip'];
      html += `<div class="comp"><div class="comp-type">${esc(c.typeFull)}</div><div class="chips">${opts.map((g) => {
        const on = String(sel[c.compId] ?? (c.groups.length === 1 ? c.groups[0].group : '')) === String(g);
        const slots = g === 'skip' ? '' : c.groups.find((x) => x.group === g).slots.join(', ');
        return `<button type="button" class="chip${on ? ' on' : ''}" data-comp="${esc(c.compId)}" data-g="${g}">${g === 'skip' ? 'pomiń' : `gr. ${g}`}${slots ? ` <small>${esc(slots)}</small>` : ''}</button>`;
      }).join('')}</div></div>`;
    }
    html += `<div class="err-box" id="sgErr" hidden></div><div class="sheet-actions"><button class="btn" id="sgSave">Dodaj do planu</button><button class="btn ghost" data-act="close">Anuluj</button></div>`;
    const sc = $('sheet').scrollTop; openSheet(html); $('sheet').scrollTop = sc;
  };
  draw();
  $('sheet').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (chip) { e.stopPropagation(); sel[chip.dataset.comp] = chip.dataset.g === 'skip' ? 'skip' : +chip.dataset.g; draw(); return; }
    if (e.target.id === 'sgSave') {
      e.stopPropagation();
      const final = {};
      for (const c of comps) {
        const g = sel[c.compId] ?? (c.groups.length === 1 ? c.groups[0].group : undefined);
        if (g === undefined) { $('sgErr').textContent = `Wybierz grupę: ${c.typeFull}`; $('sgErr').hidden = false; return; }
        final[c.compId] = g === 'skip' ? -1 : g; // -1 = żadna grupa
      }
      plan.extras = (plan.extras || []).filter((x) => x.kod !== kod);
      plan.extras.push({ kod, nazwa });
      plan.sel = { ...(plan.sel || {}), ...final };
      plan.weeks = {}; // dociągnij tygodnie razem z nowym przedmiotem
      plan.skipDiff = true; // to Twoja zmiana, nie zmiana w USOS
      save(); closeSheet(); render(); refreshActive();
      toast(`Dodano: ${nazwa}`);
    }
  };
}

// przesunięcie z siatki: pytanie o zakres
function moveSheet(ev, dayTs, startMin) {
  const plan = activePlan();
  const orig = ev.orig || ev;
  const len = minutesOf(ev.end) - minutesOf(ev.start);
  const endMin = Math.min(startMin + len, 24 * 60 - 1);
  const custom = ev.custom ? planEdits(plan).custom.find((c) => c.id === ev.cid) : null;
  const apply = (sc) => {
    const E = planEdits(plan);
    if (custom && (!custom.weekly || sc === 'series')) {
      const shift = Math.round((dayTs - startOfDay(orig.start)) / DAY);
      Object.assign(custom, { startMin, endMin, date: isoDate(addDays(dateTs(custom.date), shift)) });
    } else {
      const base = { ...(E[sc === 'occ' ? 'occ' : 'series'][sc === 'occ' ? ev.okey : ev.skey] || {}) };
      const patch = { ...base, ...makePatch(orig, { dayTs, startMin, endMin, location: ev.location, summary: ev.summary }) };
      if (patch.dayShift === undefined || Math.round((dayTs - startOfDay(orig.start)) / DAY) === 0) delete patch.dayShift;
      if (sc === 'occ') E.occ[ev.okey] = patch; else { E.series[ev.skey] = patch; delete E.occ[ev.okey]; }
    }
    save(); closeSheet(); render(); toast('Przesunięto');
  };
  const { title } = splitTitle(ev);
  openSheet(`<h3>Przesunąć zajęcia?</h3>
    <p><b>${esc(title)}</b><br>${esc(cap(fmtDay(dayTs)))}, ${fmtMin(startMin)}–${fmtMin(endMin)}</p>
    ${custom && !custom.weekly ? '<div class="sheet-actions"><button class="btn" id="mvSeries">Przesuń</button><button class="btn ghost" data-act="close">Anuluj</button></div>'
      : `<button class="btn block" id="mvOcc">Tylko te zajęcia (${esc(fmtShort(startOfDay(ev.start)))})</button>
         <button class="btn ghost block" id="mvSeries" style="margin-top:8px">Co tydzień</button>
         <button class="btn ghost block" data-act="close" style="margin-top:8px">Anuluj</button>`}`);
  $('mvOcc')?.addEventListener('click', () => apply('occ'));
  $('mvSeries')?.addEventListener('click', () => apply('series'));
}

// przeciąganie bloków w siatce tygodnia (tylko w trybie edycji)
let drag = null;
document.addEventListener('pointerdown', (e) => {
  if (!editMode) return;
  const el = e.target.closest('.wg-ev');
  if (!el) return;
  const col = el.closest('.wg-col');
  drag = { el, id: +el.dataset.i, col: +el.dataset.col, x: e.clientX, y: e.clientY, w: col.getBoundingClientRect().width, moved: false, pid: e.pointerId };
  try { el.setPointerCapture(e.pointerId); } catch (err) { /* */ }
});
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 8) return;
  drag.moved = true;
  drag.el.classList.add('dragging');
  const dCol = Math.max(-drag.col, Math.min(gridDays.length - 1 - drag.col, Math.round(dx / drag.w)));
  const dMin = Math.round((dy / HOUR_PX) * 60 / 15) * 15;
  drag.dCol = dCol; drag.dMin = dMin;
  drag.el.style.transform = `translate(${dCol * drag.w}px, ${(dMin / 60) * HOUR_PX}px)`;
  const ev = reg[drag.id];
  if (ev) drag.el.dataset.tip = fmtMin(Math.max(0, minutesOf(ev.start) + dMin));
});
document.addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.pid) return;
  const d = drag; drag = null;
  d.el.classList.remove('dragging');
  const ev = reg[d.id];
  if (!ev) return;
  if (!d.moved) { editSheet(ev); return; }
  d.el.style.transform = '';
  if (!d.dCol && !d.dMin) return;
  const newDay = gridDays[d.col + d.dCol];
  const newStart = Math.max(0, Math.min(23 * 60 + 45, minutesOf(ev.start) + d.dMin));
  moveSheet(ev, newDay, newStart);
});
document.addEventListener('pointercancel', () => { if (drag) { drag.el.style.transform = ''; drag.el.classList.remove('dragging'); drag = null; } });

function restoreAllSheet() {
  const plan = activePlan();
  const E = planEdits(plan);
  const n = Object.keys(E.occ).length + Object.keys(E.series).length;
  openSheet(`<h3>Przywrócić oryginalny plan?</h3>
    <p>Cofnie ${n} ${n === 1 ? 'zmianę' : 'zmian(y)'}: przesunięcia, ukrycia i poprawki sal. ${E.custom.length ? `Dodane przez Ciebie zajęcia (${E.custom.length}) zostaną — usuniesz je osobno albo przyciskiem niżej.` : ''}</p>
    <button class="btn block" id="raGo">Przywróć oryginał</button>
    ${E.custom.length ? '<button class="btn ghost block" id="raAll" style="margin-top:8px">Przywróć i usuń też moje zajęcia</button>' : ''}
    <button class="btn ghost block" data-act="close" style="margin-top:8px">Anuluj</button>`);
  $('raGo').addEventListener('click', () => { E.occ = {}; E.series = {}; save(); closeSheet(); render(); toast('Przywrócono oryginalny plan'); });
  $('raAll')?.addEventListener('click', () => { plan.edits = emptyEdits(); save(); closeSheet(); render(); toast('Przywrócono oryginalny plan'); });
}

// ---------- łączenie planów ----------
function mergeSheet(plan) {
  const candidates = state.plans.filter((p) => p.kind !== 'merge');
  if (candidates.length < 2) {
    openSheet(`<h3>Połącz plany</h3><p>Najpierw dodaj co najmniej dwa plany (np. oba kierunki), potem połączysz je w jeden.</p>
      <button class="btn block" data-act="add-plain">+ Dodaj plan</button>`);
    return;
  }
  const chosen = new Map((plan?.sources || []).map((s) => [s.id, s.color]));
  if (!plan) candidates.slice(0, 2).forEach((p, i) => chosen.set(p.id, SOURCE_COLORS[i]));
  const draw = () => {
    const rows = candidates.map((p) => {
      const on = chosen.has(p.id);
      const col = chosen.get(p.id);
      return `<div class="merge-row${on ? ' on' : ''}">
        <label class="merge-pick"><input type="checkbox" data-mp="${p.id}"${on ? ' checked' : ''}><span>${esc(p.name)}</span></label>
        ${on ? `<div class="chips">${SOURCE_COLORS.map((c) => `<button type="button" class="swatch${c === col ? ' on' : ''}" data-mc="${p.id}" data-color="${c}" style="background:${c}" aria-label="Kolor ${c}"></button>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    const name = $('mgName')?.value ?? (plan?.name || 'Wszystko razem');
    openSheet(`<h3>${plan ? 'Edytuj połączony plan' : 'Połącz plany'}</h3>
      <p class="hint">Zajęcia z zaznaczonych planów pokażą się razem, każdy kierunek w swoim kolorze. Plany źródłowe zostają i nadal same się aktualizują.</p>
      <label class="field"><span>Nazwa</span><input id="mgName" maxlength="40" value="${esc(name)}"></label>
      ${rows}
      <div class="err-box" id="mgErr" hidden></div>
      <div class="sheet-actions"><button class="btn" id="mgSave">${plan ? 'Zapisz' : 'Połącz'}</button><button class="btn ghost" data-act="close">Anuluj</button></div>
      ${plan ? `<button type="button" class="btn danger block" data-act="delete" data-id="${plan.id}" style="margin-top:8px">Usuń połączony plan</button>` : ''}`);
  };
  draw();
  $('sheet').onclick = (e) => {
    const cb = e.target.closest('[data-mp]');
    if (cb) {
      e.stopPropagation();
      if (cb.checked) { const used = new Set(chosen.values()); chosen.set(cb.dataset.mp, SOURCE_COLORS.find((c) => !used.has(c)) || SOURCE_COLORS[0]); }
      else chosen.delete(cb.dataset.mp);
      draw(); return;
    }
    const sw = e.target.closest('[data-mc]');
    if (sw) { e.stopPropagation(); chosen.set(sw.dataset.mc, sw.dataset.color); draw(); return; }
    if (e.target.id === 'mgSave') {
      e.stopPropagation();
      if (chosen.size < 2) { $('mgErr').textContent = 'Zaznacz co najmniej dwa plany.'; $('mgErr').hidden = false; return; }
      const target = plan || { id: uid(), kind: 'merge', edits: emptyEdits() };
      target.name = ($('mgName').value || '').trim() || 'Wszystko razem';
      target.sources = candidates.filter((p) => chosen.has(p.id)).map((p) => ({ id: p.id, color: chosen.get(p.id) }));
      if (!plan) state.plans.push(target);
      state.activeId = target.id;
      save(); closeSheet(); render(); maybeAutoRefresh();
      toast(plan ? 'Zapisano' : 'Połączono plany');
    }
  };
}

// ---------- wybór planu z katalogu USOS ----------
function addChooserSheet() {
  openSheet(`<h3>Dodaj plan</h3>
    <button class="choice" data-act="pick-faculty">
      <b>Wybierz z listy</b><span>Wydział → kierunek i semestr → Twoje grupy. Bez logowania.</span></button>
    <button class="choice" data-act="add-link">
      <b>Wklej link z USOSweb</b><span>Twój osobisty plan (eksport iCal) — dokładnie te zajęcia, na które jesteś zapisany.</span></button>
    <button class="choice" data-act="merge">
      <b>Połącz plany</b><span>Np. dwa kierunki na jednym planie — każdy w innym kolorze.</span></button>`);
}

function facultySheet() {
  let html = '<h3>Wybierz wydział</h3><p class="hint">Kierunki międzywydziałowe są zwykle przypisane do jednego wydziału — np. Aeronautics and Aerospace Engineering jest pod Wydziałem Inżynierii Środowiska i Energetyki.</p>';
  for (const [kod, nazwa] of FACULTIES) {
    html += `<button class="list-item" data-act="faculty" data-kod="${kod}">${esc(nazwa)}</button>`;
  }
  openSheet(html);
}

const groupCache = {};
async function groupListSheet(jed) {
  const fac = (FACULTIES.find((f) => f[0] === jed) || [jed, jed])[1];
  openSheet(`<h3>${esc(fac)}</h3><div class="empty"><div class="big">⏳</div><p>Pobieram listę kierunków…</p></div>`);
  try {
    if (!groupCache[jed]) {
      const [gHtml, pHtml] = await Promise.all([fetchPlanText(urls.groups(jed)), fetchPlanText(urls.programs(jed)).catch(() => '')]);
      groupCache[jed] = { groups: parseGroups(gHtml), programs: parsePrograms(pHtml) };
    }
  } catch (e) {
    openSheet(`<h3>${esc(fac)}</h3><div class="empty"><div class="big">⚠</div><p>${esc(e.message)}</p>
      <button class="btn" data-act="faculty" data-kod="${jed}">Spróbuj ponownie</button></div>`);
    return;
  }
  if (!sheetOpen) return;
  const { groups, programs } = groupCache[jed];
  openSheet(`<h3>${esc(fac)}</h3>
    <label class="field"><input id="groupSearch" placeholder="Szukaj (np. lotnicza, 3 semestr, ang)" autocomplete="off"></label>
    <div id="groupList"></div>`);
  const renderList = () => {
    const q = $('groupSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const byProg = new Map();
    for (const g of groups) {
      const prog = programs[codePrefix(g.kod)] || codePrefix(g.kod);
      const hay = `${prog} ${g.nazwa} ${g.kod}`.toLowerCase();
      if (q.some((w) => !hay.includes(w))) continue;
      if (!byProg.has(prog)) byProg.set(prog, []);
      byProg.get(prog).push(g);
    }
    let html = '';
    for (const [prog, list] of [...byProg.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pl'))) {
      html += `<div class="list-head">${esc(prog)}</div>`;
      for (const g of list) {
        html += `<button class="list-item" data-act="group" data-jed="${jed}" data-kod="${esc(g.kod)}" data-prog="${esc(prog)}" data-nazwa="${esc(g.nazwa)}">
          ${esc(g.nazwa)}<small>${esc(g.kod)}</small></button>`;
      }
    }
    $('groupList').innerHTML = html || '<p class="hint">Nic nie pasuje do wyszukiwania.</p>';
  };
  $('groupSearch').addEventListener('input', renderList);
  renderList();
}

// Arkusz wyboru grup. plan = istniejący (edycja) albo null (nowy z src).
async function groupSelectSheet({ plan, jed, kod, prog, nazwa }) {
  const src = plan ? { ...plan.src } : { jed, kod, prog, nazwa };
  openSheet(`<h3>${esc(src.prog || src.kod)}</h3><div class="empty"><div class="big">⏳</div><p>Pobieram plan…</p></div>`);
  let comps;
  try {
    if (!src.cdyd || !plan) {
      const cycles = parseCycles(await fetchPlanText(urls.group(src.jed, src.kod)));
      const cyc = pickCycle(cycles);
      if (!cyc) throw new Error('Ten kierunek nie ma opublikowanego planu w USOS.');
      src.cdyd = cyc.cdyd; src.cycleLabel = cyc.label;
    }
    comps = components(parsePlan(await fetchPlanText(urls.semester(src.kod, src.cdyd))));
    if (!comps.length) throw new Error('Plan na ten semestr jest pusty.');
  } catch (e) {
    openSheet(`<h3>${esc(src.prog || src.kod)}</h3><div class="empty"><div class="big">⚠</div><p>${esc(e.message)}</p>
      <button class="btn ghost" data-act="close">Zamknij</button></div>`);
    return;
  }
  if (!sheetOpen) return;
  const sel = { ...(plan?.sel || {}) };
  const multi = comps.filter((c) => c.groups.length > 1);
  const types = [...new Set(multi.map((c) => c.typeCode))];
  const maxG = (t) => Math.max(...multi.filter((c) => c.typeCode === t).map((c) => c.groups.length));
  const typeName = (t) => (multi.find((c) => c.typeCode === t) || {}).typeFull || t;
  const semNo = (/(\d+)\s*semestr/.exec(src.nazwa || '') || [])[1];
  const defName = plan?.name || `${src.prog || 'Plan'}${semNo ? ` · sem. ${semNo}` : ''}${/\bang\b/i.test(src.nazwa || '') ? ' (ang.)' : ''}`;

  const chips = (c) => ['all', ...c.groups.map((g) => g.group)].map((g) => {
    const on = String(sel[c.compId] ?? 'all') === String(g);
    const slots = g === 'all' ? '' : c.groups.find((x) => x.group === g).slots.join(', ');
    return `<button type="button" class="chip${on ? ' on' : ''}" data-comp="${esc(c.compId)}" data-g="${g}" title="${esc(slots)}">${g === 'all' ? 'wszystkie' : `gr. ${g}`}</button>`;
  }).join('');

  const draw = () => {
    let html = `<h3>${plan ? 'Edytuj plan' : 'Twoje grupy'}</h3>
      <label class="field"><span>Nazwa planu</span><input id="gsName" maxlength="40" value="${esc($('gsName')?.value ?? defName)}"></label>
      <p class="hint">${esc(src.cycleLabel || src.cdyd)} · wybierz grupę przy zajęciach, które mają kilka grup. Wykłady dodają się same.</p>`;
    if (types.length) {
      html += '<div class="quick"><div class="list-head">Szybko: ta sama grupa dla wszystkich</div>';
      for (const t of types) {
        html += `<div class="quick-row"><span>${esc(typeName(t))}</span><div class="chips">`;
        for (let g = 1; g <= maxG(t); g++) html += `<button type="button" class="chip" data-type="${esc(t)}" data-g="${g}">${g}</button>`;
        html += '</div></div>';
      }
      html += '</div>';
    }
    let lastName = '';
    for (const c of comps) {
      if (c.name !== lastName) { html += `<div class="list-head">${esc(c.name)}</div>`; lastName = c.name; }
      const single = c.groups.length === 1;
      html += `<div class="comp"><div class="comp-type">${esc(c.typeFull)}${single ? ` <small>· ${esc(c.groups[0].slots.join(', '))}</small>` : ''}</div>
        ${single ? '' : `<div class="chips">${chips(c)}</div>`}</div>`;
    }
    html += `<div class="sheet-actions"><button class="btn" id="gsSave">${plan ? 'Zapisz' : 'Dodaj plan'}</button>
      <button class="btn ghost" data-act="close">Anuluj</button></div>
      ${plan ? `<button type="button" class="btn danger block" data-act="delete" data-id="${plan.id}" style="margin-top:8px">Usuń ten plan</button>` : ''}`;
    const scroll = $('sheet').scrollTop;
    openSheet(html);
    $('sheet').scrollTop = scroll;
  };
  draw();

  $('sheet').onclick = async (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      e.stopPropagation();
      if (chip.dataset.comp) sel[chip.dataset.comp] = chip.dataset.g === 'all' ? 'all' : +chip.dataset.g;
      else if (chip.dataset.type) {
        for (const c of multi) if (c.typeCode === chip.dataset.type && c.groups.some((g) => g.group === +chip.dataset.g)) sel[c.compId] = +chip.dataset.g;
      }
      draw();
      return;
    }
    if (e.target.id === 'gsSave') {
      e.stopPropagation();
      const name = ($('gsName').value || '').trim() || defName;
      const target = plan || { id: uid(), kind: 'usos', src, weeks: {} };
      target.name = name;
      target.sel = sel;
      target.src = src;
      if (plan) target.events = rebuildUsosEvents(target);
      else { state.plans.push(target); }
      state.activeId = target.id;
      save(); closeSheet(); render();
      if (!plan) refreshActive();
      else toast('Zapisano');
    }
  };
}

// ---------- motywy ----------
const THEMES = [
  { id: 'blueprint', name: 'Blueprint', bar: '#0d4597', sw: ['#0d4597', '#ffffff', '#5d86c9'] },
  { id: 'klocki', name: 'Kolorowe klocki', bar: '#e7e7ea', sw: ['#b6efd9', '#f0643c', '#f6a8dc', '#0b84c8'] },
  { id: 'atrament', name: 'Atrament', bar: '#ffffff', sw: ['#1f1d3d', '#ffffff', '#f7b88f'] },
  { id: 'mono', name: 'Mono', bar: '#e6e7e9', sw: ['#e6e7e9', '#111111', '#bfe6dc'] },
  { id: 'matcha', name: 'Matcha', bar: '#fbfaf1', sw: ['#fbfaf1', '#d3e6c3', '#c4405e'] },
  { id: 'ciemny', name: 'Ciemny', bar: '#0f1115', sw: ['#0f1115', '#1c2029', '#7aa2ff'] },
];
function applyTheme() {
  const t = THEMES.find((x) => x.id === state.settings?.theme) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.setAttribute('content', t.bar);
}
applyTheme();

// ---------- ustawienia i aktualizacje ----------
let update = null; // ostatnio sprawdzona wersja
let updating = false;
const UPD_KEY = 'planapp.updCheck';

async function autoCheckUpdate() {
  if (!hasUpdater()) return;
  let last = 0;
  try { last = +localStorage.getItem(UPD_KEY) || 0; } catch (e) { /* */ }
  if (Date.now() - last < 6 * 3600000) return;
  try {
    update = await checkUpdate();
    try { localStorage.setItem(UPD_KEY, String(Date.now())); } catch (e) { /* */ }
    $('updDot').hidden = !update.newer;
    if (update.newer) toast('Jest nowa wersja apki — Ustawienia → Aktualizuj');
  } catch (e) { /* bez internetu sprawdzimy następnym razem */ }
}

async function settingsSheet() {
  const b = await currentBuild();
  const ver = b.build ? `0.1.${b.build}` : 'wersja deweloperska';
  const updBox = () => {
    if (!isNative()) return '<p class="hint">Aktualizacje działają w apce na telefonie.</p>';
    if (updating) return `<div class="upd"><div class="upd-text" id="updText">Pobieram…</div><div class="bar"><i id="updBar"></i></div></div>`;
    if (update && update.newer) {
      return `<div class="upd"><div class="upd-text"><b>Jest nowa wersja 0.1.${update.build}</b></div>
        <button class="btn block" data-act="do-update">Aktualizuj</button></div>`;
    }
    return `<div class="upd"><div class="upd-text" id="updText">${update ? 'Masz najnowszą wersję.' : ''}</div>
      <button class="btn ghost block" data-act="check-update">Sprawdź aktualizacje</button></div>`;
  };
  const cur = state.settings?.theme || 'blueprint';
  const themes = THEMES.map((t) => `<button class="theme-tile${t.id === cur ? ' on' : ''}" data-act="theme" data-theme="${t.id}">
      <span class="sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join('')}</span><span class="tn">${esc(t.name)}</span></button>`).join('');
  openSheet(`<h3>Ustawienia</h3>
    <div class="list-head">Wygląd</div>
    <div class="theme-grid">${themes}</div>
    <label class="switch-row"><span>Pokazuj weekendy w widoku tygodnia</span>
      <input type="checkbox" id="setWeekends" ${state.settings?.weekends ? 'checked' : ''}></label>
    <div class="list-head">Aktualizacje</div>
    <div id="updBox">${updBox()}</div>
    <div class="list-head">Zgłoszenia</div>
    <button class="choice" data-act="feedback"><b>Zgłoś błąd albo pomysł</b><span>Trafi prosto do twórcy apki.</span></button>
    <div class="list-head">O apce</div>
    <div class="help">Plan · ${esc(ver)}${b.sha ? ` · ${esc(b.sha)}` : ''}<br>Plany z publicznego katalogu USOSweb Politechniki Śląskiej albo z Twojego linku iCal. Dane zostają na telefonie.</div>
`);
  $('setWeekends').addEventListener('change', (e) => { state.settings.weekends = e.target.checked; save(); render(); });
  settingsSheet.redraw = () => { const el = $('updBox'); if (el) el.innerHTML = updBox(); };
}

async function doCheckUpdate() {
  const t = $('updText');
  if (t) t.textContent = 'Sprawdzam…';
  try {
    update = await checkUpdate();
    try { localStorage.setItem(UPD_KEY, String(Date.now())); } catch (e) { /* */ }
    $('updDot').hidden = !update.newer;
  } catch (e) {
    if (t) t.textContent = `Nie udało się sprawdzić: ${e.message || e}`;
    return;
  }
  settingsSheet.redraw?.();
}

async function doUpdate() {
  if (!update || updating) return;
  updating = true; settingsSheet.redraw?.();
  const text = (s) => { const t = $('updText'); if (t) t.textContent = s; };
  try {
    save();
    const res = await applyUpdate(update, (e) => {
      if (e.type === 'progress' && e.pct >= 0) {
        const bar = $('updBar'); if (bar) bar.style.width = `${e.pct}%`;
        text(`${e.phase === 'apk' ? 'Pobieram nową wersję' : 'Pobieram'}… ${e.pct}%`);
      }
      if (e.type === 'status' && e.state === 'confirm') text('Potwierdź instalację w okienku Androida');
      if (e.type === 'status' && e.state === 'failed') { updating = false; settingsSheet.redraw?.(); toast(`Nie udało się zainstalować${e.message ? ': ' + e.message : ''}`); }
    });
    if (res === 'web') text('Gotowe, uruchamiam ponownie…');
    else if (res === 'apk-silent') text('Instaluję… Apka za chwilę się zamknie — otwórz ją ponownie ikonką.');
    else if (res === 'apk') text('Instaluję… Potwierdź w okienku Androida.');
    else if (res === 'need-permission') {
      updating = false;
      openSheet(`<h3>Jedno pozwolenie</h3>
        <p>Android musi pozwolić apce instalować aktualizacje. W ustawieniach włącz <b>„Zezwalaj z tego źródła”</b> i wróć tutaj. To tylko raz.</p>
        <div class="row"><button class="btn ghost" data-act="install-settings">Otwórz ustawienia</button>
        <button class="btn" data-act="do-update">Aktualizuj</button></div>`);
    }
  } catch (e) {
    updating = false; settingsSheet.redraw?.();
    toast(e.message || 'Nie udało się zaktualizować');
  }
}

// ---------- zgłoszenia ----------
async function feedbackSheet() {
  const b = await currentBuild();
  let kind = 'bug';
  openSheet(`<h3>Zgłoś błąd albo pomysł</h3>
    <form id="fbForm" autocomplete="off">
      <div class="wswitch fb-kind"><button type="button" class="on" data-k="bug">Coś nie działa</button><button type="button" data-k="idea">Mam pomysł</button></div>
      <label class="field"><span id="fbLabel">Co się stało? Gdzie i kiedy?</span><textarea name="text" rows="5" required maxlength="4000" placeholder="np. W widoku tygodnia nie widać wtorkowego labu…"></textarea></label>
      ${canAttach() ? `<div class="field"><span>Zrzuty ekranu (do 3)</span>
        <div class="shots" id="fbShots"></div>
        <label class="btn ghost block shot-add">+ Dodaj zrzut ekranu<input type="file" accept="image/*" id="fbFile" hidden></label></div>` : ''}
      <label class="field"><span>Podpis (opcjonalnie)</span><input name="who" maxlength="40" placeholder="imię albo nick"></label>
      <label class="switch-row"><span>Dołącz informacje techniczne (wersja, motyw, plan, ostatnie błędy)</span><input type="checkbox" name="diag" checked></label>
      <div class="err-box" id="fbErr" hidden></div>
      <div class="sheet-actions"><button type="submit" class="btn" id="fbSend">Wyślij</button><button type="button" class="btn ghost" data-act="close">Anuluj</button></div>
    </form>`);
  const f = $('fbForm');
  const shots = [];
  const drawShots = () => {
    const el = $('fbShots'); if (!el) return;
    el.innerHTML = shots.map((d, i) => `<div class="shot"><img src="${d}" alt="Zrzut ${i + 1}"><button type="button" data-rm="${i}" aria-label="Usuń zrzut">×</button></div>`).join('');
    f.querySelector('.shot-add').hidden = shots.length >= 3;
  };
  $('fbFile')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { shots.push(await shrinkImage(file)); drawShots(); } catch (err) { toast(err.message); }
  });
  $('fbShots')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    e.stopPropagation(); shots.splice(+b.dataset.rm, 1); drawShots();
  });
  f.querySelector('.fb-kind').addEventListener('click', (e) => {
    const k = e.target.closest('[data-k]'); if (!k) return;
    e.stopPropagation();
    kind = k.dataset.k;
    f.querySelectorAll('.fb-kind button').forEach((x) => x.classList.toggle('on', x === k));
    $('fbLabel').textContent = kind === 'bug' ? 'Co się stało? Gdzie i kiedy?' : 'Co by się przydało?';
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = f.text.value.trim();
    if (text.length < 5) return;
    const plan = activePlan();
    const diag = f.diag.checked ? [
      `wersja: 0.1.${b.build || '?'} (${b.sha || 'dev'})`,
      `motyw: ${state.settings?.theme}, widok: ${state.view}${state.view === 'week' ? '/' + (state.settings?.weekStyle || 'grid') : ''}`,
      `plan: ${plan ? `${plan.name} [${plan.kind || 'ical'}]${plan.src ? ` ${plan.src.kod} ${plan.src.cdyd}` : ''}` : 'brak'}`,
      `planów: ${state.plans.length}, edycji: ${plan?.edits ? Object.keys(plan.edits.occ || {}).length + Object.keys(plan.edits.series || {}).length : 0}, własnych zajęć: ${plan?.edits?.custom?.length || 0}`,
      `dzień w apce: ${isoDate(selDate)}`,
      `urządzenie: ${navigator.userAgent}`,
      ...(recentErrors().length ? ['ostatnie błędy:', ...recentErrors()] : []),
    ].join('\n') : '';
    $('fbSend').disabled = true; $('fbSend').textContent = 'Wysyłam…';
    try {
      if (shots.length) $('fbSend').textContent = 'Wysyłam zrzuty…';
      const r = await sendFeedback({ kind, text, who: f.who.value, diag, shots });
      closeSheet();
      if (r.browser) { window.open(r.url, '_blank'); toast('Dokończ zgłoszenie na GitHubie'); }
      else toast(`Dzięki! Zgłoszenie #${r.number} wysłane`);
    } catch (err) {
      logError(`feedback: ${err.message}`);
      $('fbErr').textContent = `Nie udało się wysłać: ${err.message}. Sprawdź internet i spróbuj jeszcze raz.`;
      $('fbErr').hidden = false; $('fbSend').disabled = false; $('fbSend').textContent = 'Wyślij';
    }
  });
}

// ---------- zdarzenia ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], [data-view], [data-day]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.dataset.view) { state.view = el.dataset.view; save(); render(); window.scrollTo(0, 0); return; }
  if (act === 'edit') {
    e.stopPropagation();
    const p = state.plans.find((x) => x.id === el.dataset.id);
    if (p?.kind === 'usos') groupSelectSheet({ plan: p }); else if (p?.kind === 'merge') mergeSheet(p); else formSheet(p);
    return;
  }
  if (act === 'theme') {
    state.settings.theme = el.dataset.theme; save(); applyTheme(); render();
    document.querySelectorAll('.theme-tile').forEach((t) => t.classList.toggle('on', t.dataset.theme === el.dataset.theme));
    return;
  }
  if (act === 'check-update') { doCheckUpdate(); return; }
  if (act === 'do-update') { doUpdate(); return; }
  if (act === 'install-settings') { openInstallSettings(); return; }
  if (act === 'pick-faculty') { facultySheet(); return; }
  if (act === 'add-link') { formSheet(null); return; }
  if (act === 'faculty') { groupListSheet(el.dataset.kod); return; }
  if (act === 'group') { groupSelectSheet({ jed: el.dataset.jed, kod: el.dataset.kod, prog: el.dataset.prog, nazwa: el.dataset.nazwa }); return; }
  if (act === 'pick') {
    state.activeId = el.dataset.id; save(); closeSheet(); render(); maybeAutoRefresh(); return;
  }
  if (act === 'add') { addChooserSheet(); return; }
  if (act === 'close') { closeSheet(); return; }
  if (act === 'delete') {
    const p = state.plans.find((x) => x.id === el.dataset.id);
    if (p && el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = `Na pewno usunąć „${p.name}”?`; return; }
    state.plans = state.plans.filter((x) => x.id !== el.dataset.id);
    for (const m of state.plans) if (m.kind === 'merge') m.sources = (m.sources || []).filter((s) => s.id !== el.dataset.id);
    if (state.activeId === el.dataset.id) state.activeId = state.plans[0]?.id || null;
    save(); closeSheet(); render(); toast('Plan usunięty'); return;
  }
  if (act === 'refresh') { refreshActive({ manual: true }); return; }
  if (act === 'toggle') {
    if (editMode && reg[+el.dataset.i]) { editSheet(reg[+el.dataset.i]); return; }
    el.classList.toggle('open'); return;
  }
  if (act === 'merge') { mergeSheet(null); return; }
  if (act === 'feedback') { feedbackSheet(); return; }
  if (act === 'ev-edit') { const ev = reg[+el.dataset.i]; if (ev) editSheet(ev); return; }
  if (act === 'add-plain') { addChooserSheet(); return; }
  if (act === 'edit-add') { addChoiceSheet(); return; }
  if (act === 'add-own') { editSheet(null); return; }
  if (act === 'add-subject') { subjectSearchSheet(); return; }
  if (act === 'pick-subject') { subjectGroupSheet(el.dataset.kod, el.dataset.nazwa); return; }
  if (act === 'rm-extra') {
    const plan = activePlan();
    const x = (plan.extras || [])[+el.dataset.i];
    if (x) { plan.extras.splice(+el.dataset.i, 1); plan.weeks = {}; plan.skipDiff = true; save(); closeSheet(); render(); refreshActive(); toast(`Usunięto: ${x.nazwa}`); }
    return;
  }
  if (act === 'edit-restore') { restoreAllSheet(); return; }
  if (act === 'edit-done') { setEditMode(false); return; }
  if (act === 'week-style') { state.settings.weekStyle = el.dataset.style; save(); render(); return; }
  if (act === 'ev') { if (editMode) return; const ev = reg[+el.dataset.i]; if (ev) eventSheet(ev); return; }
  if (el.dataset.day) {
    if (sheetOpen) closeSheet();
    selDate = +el.dataset.day;
    if (act === 'goto') state.view = 'day';
    render(); return;
  }
});

$('planSwitch').addEventListener('click', plansSheet);
$('plansBtn').addEventListener('click', plansSheet);
$('settingsBtn').addEventListener('click', settingsSheet);
$('editBtn').addEventListener('click', () => setEditMode(!editMode));
$('sheetBackdrop').addEventListener('click', () => closeSheet());
$('refreshBtn').addEventListener('click', () => refreshActive({ manual: true }));
$('dateLabel').addEventListener('click', () => { selDate = startOfDay(Date.now()); render(); });
const step = (dir) => { selDate = addDays(selDate, state.view === 'week' ? 7 * dir : dir); render(); };
$('prevBtn').addEventListener('click', () => step(-1));
$('nextBtn').addEventListener('click', () => step(1));

// przesuwanie palcem między dniami / tygodniami
let touch = null;
$('content').addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY, t: Date.now() }; }, { passive: true });
$('content').addEventListener('touchend', (e) => {
  if (!touch || state.view === 'changes') return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 50 && Date.now() - touch.t < 600) step(dx < 0 ? 1 : -1);
  touch = null;
}, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { render(); maybeAutoRefresh(); autoCheckUpdate(); }
});
setInterval(() => { if (!document.hidden && !sheetOpen) render(); }, 60000);

// start
render();
maybeAutoRefresh();
markStarted();
autoCheckUpdate();
