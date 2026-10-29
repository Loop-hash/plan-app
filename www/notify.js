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

// Lista przypomnień do zaplanowania: [{id, at, title, body}]
// cfg: { dayBefore: bool, dayBeforeMin: 19*60, before: bool, beforeMin: 120, morningMin: 7*60+30 }
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
    if (cfg.dayBefore) {
      out.push({ at: at(-1, cfg.dayBeforeMin ?? 19 * 60), title: `Jutro: ${what}`, body: [where, x.note].filter(Boolean).join(' · ') || 'Powodzenia!' });
    }
    if (cfg.before) {
      const t = x.startMin != null ? at(0, Math.max(0, x.startMin - (cfg.beforeMin ?? 120))) : at(0, cfg.morningMin ?? 7 * 60 + 30);
      const lead = x.startMin != null ? `Za ${cfg.beforeMin >= 60 ? `${Math.round((cfg.beforeMin ?? 120) / 60)} h` : `${cfg.beforeMin} min`}` : 'Dziś';
      out.push({ at: t, title: `${lead}: ${what}`, body: [where, x.note].filter(Boolean).join(' · ') || 'Powodzenia!' });
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
