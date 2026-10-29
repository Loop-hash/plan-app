// Przypomnienia o egzaminach — powiadomienia Androida (plugin @capacitor/local-notifications).
// Przy każdej zmianie egzaminów albo ustawień: kasujemy stare i planujemy na nowo.

const LN = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
  ? window.Capacitor.Plugins.LocalNotifications : null);
export const notifyAvailable = () => !!LN();

const CHANNEL = 'egzaminy';
const ID_BASE = 700000; // nasze powiadomienia mają id od tej liczby w górę
const MAX = 120;

export async function ensurePermission(ask = false) {
  const p = LN();
  if (!p) return false;
  try {
    let st = await p.checkPermissions();
    if (st.display !== 'granted' && ask) st = await p.requestPermissions();
    return st.display === 'granted';
  } catch (e) { return false; }
}

let channelMade = false;
async function channel(p) {
  if (channelMade) return;
  try {
    await p.createChannel({ id: CHANNEL, name: 'Egzaminy i kolokwia', description: 'Przypomnienia o zbliżających się egzaminach', importance: 4, visibility: 1, vibration: true });
  } catch (e) { /* starszy Android — kanał niepotrzebny */ }
  channelMade = true;
}

// Kiedy przypominać: dni przed egzaminem (0 = w dniu egzaminu)
export const LEADS = [[14, '2 tyg. przed'], [7, 'tydzień przed'], [3, '3 dni przed'], [1, 'dzień przed'], [0, 'w dniu']];
export const defaultLeads = () => [1]; // domyślnie: dzień przed
const leadTitle = (d) => (d === 1 ? 'Jutro' : d === 7 ? 'Za tydzień' : d === 14 ? 'Za 2 tygodnie' : `Za ${d} dni`);

// Lista przypomnień do zaplanowania: [{id, at, title, body}]
// cfg: { dayBefore, dayBeforeMin: 19*60, before, beforeMin: 120, morningMin: 7*60+30 }
// egzamin może mieć własne x.leads = [7, 1, 0] (dni przed); bez tego obowiązują ustawienia ogólne
export function planReminders(exams, cfg, now = Date.now(), label = (k) => k) {
  const out = [];
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (m) => `${Math.floor(m / 60)}:${pad(m % 60)}`;
  let n = 0;
  for (const x of exams || []) {
    if (x.remind === false) continue;
    const [y, mo, d] = x.date.split('-').map(Number);
    const at = (dd, min) => new Date(y, mo - 1, d + dd, Math.floor(min / 60), min % 60).getTime();
    const what = `${label(x.kind)}: ${x.subject}`;
    const where = [x.startMin != null ? `o ${hm(x.startMin)}` : '', x.location ? `sala ${x.location}` : ''].filter(Boolean).join(', ');
    const body = [where, x.note].filter(Boolean).join(' · ') || 'Powodzenia!';
    const leads = Array.isArray(x.leads) ? x.leads : defaultLeads(cfg);
    for (const L of [...new Set(leads)].sort((a, b) => b - a)) {
      if (L > 0) {
        out.push({ at: at(-L, cfg.dayBeforeMin ?? 19 * 60), title: `${leadTitle(L)}: ${what}`, body: L >= 3 && !x.note ? `${body === 'Powodzenia!' ? '' : body + ' · '}czas zacząć się uczyć` : body });
      } else {
        const bm = cfg.beforeMin ?? 120;
        const t = x.startMin != null ? at(0, Math.max(0, x.startMin - bm)) : at(0, cfg.morningMin ?? 7 * 60 + 30);
        const lead = x.startMin != null ? `Za ${bm >= 60 ? `${Math.round(bm / 60)} h` : `${bm} min`}` : 'Dziś';
        out.push({ at: t, title: `${lead}: ${what}`, body });
      }
    }
  }
  return out
    .filter((r) => r.at > now + 30000)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX)
    .map((r) => ({ ...r, id: ID_BASE + (n++) }));
}

export async function reschedule(exams, cfg, label) {
  const p = LN();
  if (!p) return { scheduled: 0, reason: 'web' };
  if (!(await ensurePermission(false))) return { scheduled: 0, reason: 'permission' };
  await channel(p);
  try {
    const pend = await p.getPending();
    const ours = (pend.notifications || []).filter((x) => x.id >= ID_BASE && x.id < ID_BASE + 1000).map((x) => ({ id: x.id }));
    if (ours.length) await p.cancel({ notifications: ours });
  } catch (e) { /* */ }
  if (!cfg.enabled) return { scheduled: 0, reason: 'off' };
  const list = planReminders(exams, cfg, Date.now(), label);
  if (list.length) {
    await p.schedule({
      notifications: list.map((r) => ({
        id: r.id, title: r.title, body: r.body, channelId: CHANNEL,
        schedule: { at: new Date(r.at), allowWhileIdle: true },
      })),
    });
  }
  return { scheduled: list.length };
}
