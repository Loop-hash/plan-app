// Publiczne plany z katalogu USOSweb Politechniki Śląskiej (bez logowania).
// Parsowanie na wyrażeniach regularnych, żeby działało też w testach w Node.

export const BASE = 'https://usosweb.polsl.pl/kontroler.php?_action=';
const enc = encodeURIComponent;

export const FACULTIES = [
  ['RAR', 'Wydział Architektury'],
  ['RAU', 'Wydział Automatyki, Elektroniki i Informatyki'],
  ['RB', 'Wydział Budownictwa'],
  ['RCH', 'Wydział Chemiczny'],
  ['RE', 'Wydział Elektryczny'],
  ['RG', 'Wydział Górnictwa, Inżynierii Bezpieczeństwa i Automatyki Przemysłowej'],
  ['RIB', 'Wydział Inżynierii Biomedycznej'],
  ['RIE', 'Wydział Inżynierii Środowiska i Energetyki'],
  ['RM', 'Wydział Inżynierii Materiałowej i Cyfryzacji Przemysłu'],
  ['RMS', 'Wydział Matematyki Stosowanej'],
  ['RMT', 'Wydział Mechaniczny Technologiczny'],
  ['ROZ', 'Wydział Organizacji i Zarządzania'],
  ['RT', 'Wydział Transportu i Inżynierii Lotniczej'],
  ['RIF', 'Instytut Fizyki'],
  ['KS', 'Kolegium Studiów'],
];

export const urls = {
  groups: (jed) => `${BASE}katalog2/przedmioty/wybierzGrupePrzedmiotow&jed_org_kod=${enc(jed)}&tab_offset=0&tab_limit=500&tab_order=1a2a`,
  programs: (jed) => `${BASE}katalog2/programy/szukajProgramu&method=by_faculty&jed_org_kod=${enc(jed)}`,
  group: (jed, kod) => `${BASE}katalog2/przedmioty/szukajPrzedmiotu&method=faculty_groups&kierujNaPlanyGrupy=1&jed_org_kod=${enc(jed)}&grupaKod=${enc(kod)}`,
  semester: (kod, cdyd) => `${BASE}katalog2/przedmioty/pokazPlanGrupyPrzedmiotow&grupa_kod=${enc(kod)}&cdyd_kod=${enc(cdyd)}&plan_division=semester`,
  subjectSearch: (q) => `${BASE}katalog2/przedmioty/szukajPrzedmiotu&method=default&pattern=${enc(q)}&tab_limit=60`,
  subjectSemester: (kod, cdyd) => `${BASE}katalog2/przedmioty/pokazPlanZajecPrzedmiotu&prz_kod=${enc(kod)}&cdyd_kod=${enc(cdyd)}&plan_division=semester`,
  subjectWeek: (kod, cdyd, monday) => `${BASE}katalog2/przedmioty/pokazPlanZajecPrzedmiotu&prz_kod=${enc(kod)}&cdyd_kod=${enc(cdyd)}&plan_division=week&plan_week_sel_week=${monday}`,
  week: (kod, cdyd, monday) => `${BASE}katalog2/przedmioty/pokazPlanGrupyPrzedmiotow&grupa_kod=${enc(kod)}&cdyd_kod=${enc(cdyd)}&plan_division=week&plan_week_sel_week=${monday}`,
};

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–' };
export function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}
const strip = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Lista grup przedmiotów wydziału: [{kod, nazwa}]
export function parseGroups(html) {
  const out = [];
  const seen = new Set();
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 3) continue;
    const link = /grupaKod=([^'"&]+)/.exec(cells[2]);
    if (!link) continue;
    const kod = decodeURIComponent(link[1]);
    if (seen.has(kod)) continue;
    seen.add(kod);
    out.push({ kod, nazwa: strip(cells[1]).replace(/^["'„]+|["'”]+$/g, '') });
  }
  return out;
}

// Wyniki wyszukiwania przedmiotów: [{kod, nazwa, jedn}]
export function parseSubjects(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = m[1];
    const link = /pokazPrzedmiot&(?:amp;)?prz_kod=([^'"&]+)[^>]*>([\s\S]*?)<\/a>/.exec(row);
    if (!link) continue;
    const kod = decodeURIComponent(link[1]);
    if (seen.has(kod)) continue;
    seen.add(kod);
    const jedn = (/pokazJednostke[^>]*>([\s\S]*?)<\/a>/.exec(row) || [])[1];
    out.push({ kod, nazwa: strip(link[2]), jedn: strip(jedn || '') });
  }
  return out;
}

// Programy studiów wydziału -> mapa prefiks kodu => nazwa kierunku.
export function parsePrograms(html) {
  const map = {};
  for (const m of html.matchAll(/pokazProgram&(?:amp;)?prg_kod=([^'"&]+)['"][^>]*>([\s\S]*?)<\/a>/g)) {
    const kod = decodeURIComponent(m[1]);
    const name = strip(m[2]).split(',')[0];
    const prefix = (/^[A-Za-zĄ-ż]+/.exec(kod) || [''])[0];
    if (prefix && name && !map[prefix]) map[prefix] = name;
  }
  return map;
}

export function codePrefix(kod) {
  return (/^[A-Za-zĄ-ż]+/.exec(kod) || [kod])[0];
}

// Numer semestru z nazwy grupy („… 3 semestr …”, „sem. 3”)
export function semesterOf(nazwa) {
  const m = /(\d+)\s*sem/i.exec(nazwa || '') || /sem(?:estr)?\.?\s*(\d+)/i.exec(nazwa || '');
  return m ? +m[1] : null;
}
// Grupy specjalnościowe/obieralne z tego samego kierunku i semestru co główna grupa —
// na części kierunków USOS trzyma je osobno, więc ich zajęcia nie są w planie „obowiązkowych”.
export function relatedGroups(groups, main) {
  const pre = codePrefix(main.kod);
  const sem = semesterOf(main.nazwa);
  const niest = /niestacj/i.test(main.nazwa || '');
  return groups.filter((g) => g.kod !== main.kod && codePrefix(g.kod) === pre
    && sem != null && semesterOf(g.nazwa) === sem
    && /niestacj/i.test(g.nazwa || '') === niest
    && /specjaln|spec\.|obieraln|wybieraln/i.test(g.nazwa || ''));
}

// Strona grupy -> dostępne cykle (semestry) z planem: [{cdyd, label}]
export function parseCycles(html) {
  const out = [];
  for (const m of html.matchAll(/pokazPlanGrupyPrzedmiotow&(?:amp;)?grupa_kod=[^'"&]+&(?:amp;)?cdyd_kod=([^'"&]+)['"][^>]*>([\s\S]*?)<\/a>/g)) {
    const cdyd = decodeURIComponent(m[1]);
    if (!out.some((c) => c.cdyd === cdyd)) out.push({ cdyd, label: strip(m[2]) });
  }
  return out;
}

// Który cykl jest „teraz”: zima X/X+1-Z od października do lutego, lato -L od marca.
export function currentCycleCode(date = new Date()) {
  const y = date.getFullYear();
  const mo = date.getMonth() + 1;
  if (mo >= 10) return `${y}/${y + 1}-Z`;
  if (mo <= 2) return `${y - 1}/${y}-Z`;
  return `${y - 1}/${y}-L`;
}
export function pickCycle(cycles, date = new Date()) {
  if (!cycles.length) return null;
  const cur = currentCycleCode(date);
  return cycles.find((c) => c.cdyd === cur) || cycles[cycles.length - 1];
}

const DAYS = { 'poniedziałek': 0, 'wtorek': 1, 'środa': 2, 'czwartek': 3, 'piątek': 4, 'sobota': 5, 'niedziela': 6 };
const TYPE_NAMES = {
  WYK: 'wykład', CW: 'ćwiczenia', LAB: 'laboratorium', PROJ: 'projekt', PRO: 'projekt', SEM: 'seminarium',
  LEK: 'lektorat', WF: 'wychowanie fizyczne', KON: 'konwersatorium', PRA: 'praktyki',
};

function slot(block, name) {
  const re = new RegExp(`<(div|span)[^>]*slot="${name}"[^>]*>([\\s\\S]*?)</\\1>\\s*(?=<(?:span|div)[^>]*slot=|</timetable-entry>)`);
  const m = re.exec(block);
  return m ? m[2] : '';
}

// Plan (semestralny albo tygodniowy) -> wpisy.
// dayIndex: 0 = poniedziałek.
export function parsePlan(html) {
  const i = html.indexOf('<usos-timetable');
  if (i < 0) {
    if (/logowanie|zaloguj/i.test(html) && !/timetable/i.test(html)) throw new Error('USOS poprosił o logowanie — ten plan nie jest publiczny.');
    return [];
  }
  const end = html.indexOf('</usos-timetable>', i);
  const body = html.slice(i, end < 0 ? undefined : end);
  const parts = body.split(/<h4>/).slice(1);
  const entries = [];
  for (const part of parts) {
    const dayName = strip(part.slice(0, part.indexOf('</h4>'))).toLowerCase();
    const dayIndex = DAYS[dayName];
    if (dayIndex === undefined) continue;
    for (const em of part.matchAll(/<timetable-entry([\s\S]*?)>([\s\S]*?)<\/timetable-entry>/g)) {
      const attrs = em[1];
      const inner = em[2] + '</timetable-entry>';
      const name = decode((/\sname="([^"]*)"/.exec(attrs) || [])[1] || '');
      const subjectId = decode((/name-id="([^"]*)"/.exec(attrs) || [])[1] || '');
      const info = strip(slot(inner, 'info'));
      const dInfo = slot(inner, 'dialog-info');
      const event = strip(slot(inner, 'dialog-event'));
      const person = slot(inner, 'dialog-person');
      const place = slot(inner, 'dialog-place');
      const link = /zaj_cyk_id=(\d+)&(?:amp;)?gr_nr=(\d+)/.exec(dInfo);
      const tm = /(\d{1,2}):(\d{2})\s*[—–-]\s*(\d{1,2}):(\d{2})/.exec(event);
      if (!tm) continue;
      const typeCode = ((/^([A-ZĆŁŚŻŹ]+)/.exec(info) || [])[1] || '').toUpperCase();
      const typeFull = strip(dInfo).replace(/,\s*grupa\s*\d+.*$/i, '') || TYPE_NAMES[typeCode] || typeCode;
      const room = ((/\((.+?),\s*bud\./.exec(info) || /\((.*)\)\s*$/.exec(info) || [])[1] || '').replace(/\s+/g, ' ').trim();
      const placeLinks = [...place.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((a) => strip(a[1]));
      const buildingFull = (placeLinks[1] || '').replace(/\s*\[[^\]]*\]\s*$/, '');
      const buildingName = shortBuilding(buildingFull);
      const teachers = [...person.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((a) => strip(a[1])).filter(Boolean);
      const pattern = (/^(każd[ya]|co drug[aiy][^,]*|[^,]*\b(?:nieparzyste|parzyste)\b[^,]*)/i.exec(event) || [])[1] || '';
      entries.push({
        dayIndex,
        startMin: +tm[1] * 60 + +tm[2],
        endMin: +tm[3] * 60 + +tm[4],
        name: name || subjectId,
        subjectId,
        compId: link ? link[1] : `${subjectId}|${typeCode}`,
        group: link ? +link[2] : +((/gr\.\s*(\d+)/.exec(info) || [])[1] || 0),
        typeCode,
        typeFull,
        room,
        building: buildingName,
        buildingFull,
        teachers,
        pattern: pattern.trim(),
      });
    }
  }
  return entries;
}

// „Wydział Inżynierii Środowiska i Energetyki - budynek A” -> „IŚE bud. A”, „CNT - Centrum…” -> „CNT”
export function shortBuilding(name) {
  if (!name) return '';
  const [left, right] = name.split(/\s+-\s+/);
  if (right && left.length <= 6) return left;
  const acronym = (txt) => txt.split('/')[0].replace(/^\s*Wydział\s+/i, '')
    .split(/[\s,-]+/).filter((w) => /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(w)).map((w) => w[0]).join('');
  const bud = right && /budynek\s+(\S+)/i.exec(right);
  const a = acronym(left);
  return bud ? `${a} bud. ${bud[1]}` : a || name;
}

// Komponenty do wyboru grup: przedmiot + rodzaj zajęć -> lista grup.
export function components(entries) {
  const map = new Map();
  for (const e of entries) {
    let c = map.get(e.compId);
    if (!c) {
      c = { compId: e.compId, name: e.name, subjectId: e.subjectId, typeCode: e.typeCode, typeFull: e.typeFull, groups: new Map() };
      map.set(e.compId, c);
    }
    const g = c.groups.get(e.group) || { group: e.group, slots: [] };
    const label = `${['pn', 'wt', 'śr', 'cz', 'pt', 'sb', 'nd'][e.dayIndex]} ${fmtMin(e.startMin)}${e.pattern && !/^każd/i.test(e.pattern) ? ` (${shortPattern(e.pattern)})` : ''}`;
    if (!g.slots.includes(label)) g.slots.push(label);
    c.groups.set(e.group, g);
  }
  const order = { WYK: 0, CW: 1, LAB: 2, PROJ: 3, PRO: 3, SEM: 4 };
  return [...map.values()]
    .map((c) => ({ ...c, groups: [...c.groups.values()].sort((a, b) => a.group - b.group) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pl') || (order[a.typeCode] ?? 9) - (order[b.typeCode] ?? 9));
}
function shortPattern(p) {
  if (/nieparzyste/i.test(p)) return 'nieparz.';
  if (/parzyste/i.test(p)) return 'parz.';
  return 'czasem';
}
const fmtMin = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

// Czy wpis należy do wybranych grup. selection: {compId: numerGrupy}
export function isSelected(entry, selection) {
  const g = selection ? selection[entry.compId] : undefined;
  return g === undefined || g === null || g === 'all' || +g === entry.group;
}

// Wpis z planu tygodniowego -> zdarzenie w formacie apki.
export function toEvent(entry, mondayTs) {
  const d = new Date(mondayTs);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + entry.dayIndex);
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(entry.startMin / 60), entry.startMin % 60).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(entry.endMin / 60), entry.endMin % 60).getTime();
  const loc = [entry.room, entry.building].filter(Boolean).join(' · ');
  const desc = [
    `${entry.typeFull}, grupa ${entry.group}`,
    entry.teachers.length ? `Prowadzący: ${entry.teachers.join(', ')}` : '',
    entry.buildingFull ? `Budynek: ${entry.buildingFull}` : '',
  ].filter(Boolean).join('\n');
  return {
    uid: `${entry.compId}-${entry.group}-${start}`,
    comp: `${entry.compId}-${entry.group}`,
    summary: entry.name,
    location: loc,
    description: desc,
    allDay: false,
    start,
    end,
    group: entry.group,
    typeCode: entry.typeCode,
  };
}

export function mondayISO(ts) {
  const d = new Date(ts);
  const wd = (d.getDay() + 6) % 7;
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
}
export function isoToTs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
