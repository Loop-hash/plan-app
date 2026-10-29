import { parseICS, classType, diffEvents, normalizeUrl } from './ics.js';

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
    if (s && Array.isArray(s.plans)) return { view: 'day', ...s };
  } catch (e) { /* brak/uszkodzone dane */ }
  return { plans: [], activeId: null, view: 'day' };
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
function eventsOn(plan, dayTs) {
  const end = addDays(dayTs, 1);
  return (plan?.events || []).filter((e) => e.start < end && e.end > dayTs);
}
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
  const type = classType(ev);
  let title = ev.summary;
  title = title.replace(/\s*[-–,:]\s*(wykład|ćwiczenia|laboratorium|projekt|seminarium|lektorat|wyk|ćw|lab)\b.*$/i, '');
  title = title.replace(/\s*\((wykład|ćwiczenia|laboratorium|projekt|seminarium|wyk|ćw|cw|lab|proj)[^)]*\)\s*$/i, '');
  if (!title.trim()) title = ev.summary;
  return { type, title: title.trim() };
}

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

async function refreshPlan(plan, { quiet = false } = {}) {
  let changed = 0;
  const text = await fetchPlanText(plan.url);
  const events = parseICS(text);
  if (plan.events && plan.fetchedAt) {
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
  try {
    const changed = await refreshPlan(plan);
    if (manual && !changed) toast('Plan odświeżony — bez zmian');
  } catch (e) {
    plan.error = e.message || String(e);
    if (manual) toast(plan.error);
  } finally {
    refreshing = false; save(); render();
  }
}

function maybeAutoRefresh() {
  const plan = activePlan();
  if (plan && (!plan.fetchedAt || Date.now() - plan.fetchedAt > AUTO_REFRESH_MS)) refreshActive();
}

// ---------- render ----------
function render() { renderTop(); renderContent(); }

function renderTop() {
  const plan = activePlan();
  $('planName').textContent = plan ? plan.name : 'Plan zajęć';
  $('refreshBtn').classList.toggle('spin', refreshing);
  $('refreshBtn').hidden = !plan;
  const st = $('status');
  st.classList.remove('err');
  if (!plan) st.textContent = '';
  else if (refreshing) st.textContent = 'Odświeżanie…';
  else if (plan.error) { st.textContent = `⚠ ${plan.error}` + (plan.fetchedAt ? ` · dane z ${ago(plan.fetchedAt)}` : ''); st.classList.add('err'); }
  else if (plan.fetchedAt) st.textContent = `Zaktualizowano ${ago(plan.fetchedAt)}`;
  else st.textContent = '';

  const hasPlan = !!plan;
  $('navRow').hidden = !hasPlan || state.view === 'changes';
  $('tabs').hidden = !hasPlan;
  $('weekStrip').hidden = !hasPlan || state.view !== 'day';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === state.view));
  const badge = $('changesBadge');
  const n = plan?.changesUnseen ? plan.changes?.items?.length || 0 : 0;
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
  if (!plan.events) {
    c.innerHTML = plan.error
      ? `<div class="empty"><div class="big">⚠</div><h2>Nie udało się pobrać planu</h2><p>${esc(plan.error)}</p><button class="btn" data-act="refresh">Spróbuj ponownie</button></div>`
      : `<div class="empty"><div class="big">⏳</div><h2>Pobieranie planu…</h2></div>`;
    return;
  }
  if (state.view === 'week') c.innerHTML = weekView(plan);
  else if (state.view === 'changes') c.innerHTML = changesView(plan);
  else c.innerHTML = dayView(plan);
}

function emptyNoPlans() {
  return `<div class="empty">
    <div class="big">📅</div>
    <h2>Dodaj swój pierwszy plan</h2>
    <p>Wklej link do planu z USOSweb, a apka będzie go sama aktualizować.</p>
    <button class="btn" data-act="add">+ Dodaj plan</button>
  </div>${helpBox()}`;
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

function eventCard(ev, now) {
  const { type, title } = splitTitle(ev);
  const past = ev.end <= now;
  const isNow = ev.start <= now && now < ev.end;
  const prog = isNow ? ((now - ev.start) / (ev.end - ev.start)) * 100 : 0;
  const right = isNow
    ? `<span class="now-tag">teraz · do końca ${dur(ev.end - now)}</span>`
    : !past && ev.start - now < 3 * 3600000 ? `<span>za ${dur(ev.start - now)}</span>` : `<span>${dur(ev.end - ev.start)}</span>`;
  const desc = ev.description && ev.description !== ev.summary ? `<div class="desc">${esc(ev.description)}</div>` : '';
  return `<div class="card${past ? ' past' : ''}${isNow ? ' now' : ''}" style="--c: var(--${type.key})" data-act="toggle">
    <div class="time"><span><b>${ev.allDay ? 'cały dzień' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`}</b></span>${right}</div>
    <div class="title">${esc(title)}</div>
    <div class="meta"><span class="type-pill">${esc(type.label)}</span>${ev.location ? `<span>📍 ${esc(ev.location)}</span>` : ''}</div>
    ${desc}
    ${isNow ? `<div class="progress" style="width:${prog.toFixed(1)}%"></div>` : ''}
  </div>`;
}

function dayView(plan) {
  const evs = eventsOn(plan, selDate);
  const now = Date.now();
  if (!evs.length) {
    const next = (plan.events || []).find((e) => e.start >= addDays(selDate, 1));
    return `<div class="empty"><div class="big">☕</div><h2>Wolne</h2>
      ${next ? `<p>Najbliższe zajęcia: <b>${esc(fmtDay(next.start))}</b>, ${fmtTime(next.start)}</p><button class="btn ghost" data-act="goto" data-day="${startOfDay(next.start)}">Przejdź</button>` : '<p>Brak kolejnych zajęć w planie.</p>'}
    </div>`;
  }
  let html = '';
  let lastEnd = null;
  for (const ev of evs) {
    if (lastEnd !== null && ev.start - lastEnd >= 15 * 60000) {
      html += `<div class="gap">okienko ${dur(ev.start - lastEnd)}</div>`;
    }
    html += eventCard(ev, now);
    lastEnd = Math.max(lastEnd ?? 0, ev.end);
  }
  const first = evs[0];
  const last = evs[evs.length - 1];
  html += `<p class="hint" style="text-align:center;margin-top:14px">${evs.length} ${zajec(evs.length)} · ${first.allDay ? '' : `${fmtTime(first.start)}–${fmtTime(last.end)}`}</p>`;
  return html;
}

function weekView(plan) {
  const ws = startOfWeek(selDate);
  const today = startOfDay(Date.now());
  let html = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const evs = eventsOn(plan, d);
    if (!evs.length && i >= 5) continue; // pusty weekend pomijamy
    html += `<div class="day-head${d === today ? ' today' : ''}" data-act="goto" data-day="${d}">
      <span>${esc(cap(fmtDay(d)))}</span><small>${evs.length ? `${fmtTime(evs[0].start)}–${fmtTime(evs[evs.length - 1].end)}` : 'wolne'}</small></div>`;
    for (const ev of evs) {
      const { type, title } = splitTitle(ev);
      html += `<div class="compact" style="--c: var(--${type.key})">
        <div class="t">${fmtTime(ev.start)}–${fmtTime(ev.end)}<br><span class="type-pill">${esc(type.code)}</span></div>
        <div><div class="n">${esc(title)}</div>${ev.location ? `<div class="l">📍 ${esc(ev.location)}</div>` : ''}</div>
      </div>`;
    }
  }
  return html || '<div class="empty"><div class="big">☕</div><h2>Wolny tydzień</h2></div>';
}

function changesView(plan) {
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
    html += `<div class="change ${c.type}"><div class="k">${k}</div><div class="n">${esc(title)}</div><div class="d">${d}</div></div>`;
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
  $('sheet').hidden = true; $('sheetBackdrop').hidden = true;
  if (!fromPop) { try { history.back(); } catch (e) { /* */ } }
}
window.addEventListener('popstate', () => closeSheet(true));

function plansSheet() {
  const act = activePlan();
  let html = '<h3>Twoje plany</h3>';
  if (!state.plans.length) html += '<p class="hint">Nie masz jeszcze żadnego planu.</p>';
  for (const p of state.plans) {
    const sub = p.error ? `⚠ ${p.error}` : p.fetchedAt ? `${(p.events || []).length} ${zajec((p.events || []).length)} · ${ago(p.fetchedAt)}` : 'jeszcze nie pobrany';
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

// ---------- zdarzenia ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], [data-view], [data-day]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.dataset.view) { state.view = el.dataset.view; save(); render(); window.scrollTo(0, 0); return; }
  if (act === 'edit') { e.stopPropagation(); formSheet(state.plans.find((p) => p.id === el.dataset.id)); return; }
  if (act === 'pick') {
    state.activeId = el.dataset.id; save(); closeSheet(); render(); maybeAutoRefresh(); return;
  }
  if (act === 'add') { formSheet(null); return; }
  if (act === 'close') { closeSheet(); return; }
  if (act === 'delete') {
    const p = state.plans.find((x) => x.id === el.dataset.id);
    if (p && el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = `Na pewno usunąć „${p.name}”?`; return; }
    state.plans = state.plans.filter((x) => x.id !== el.dataset.id);
    if (state.activeId === el.dataset.id) state.activeId = state.plans[0]?.id || null;
    save(); closeSheet(); render(); toast('Plan usunięty'); return;
  }
  if (act === 'refresh') { refreshActive({ manual: true }); return; }
  if (act === 'toggle') { el.classList.toggle('open'); return; }
  if (el.dataset.day) {
    selDate = +el.dataset.day;
    if (act === 'goto') state.view = 'day';
    render(); return;
  }
});

$('planSwitch').addEventListener('click', plansSheet);
$('plansBtn').addEventListener('click', plansSheet);
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
  if (!document.hidden) { render(); maybeAutoRefresh(); }
});
setInterval(() => { if (!document.hidden && !sheetOpen) render(); }, 60000);

// start
render();
maybeAutoRefresh();
