// Aktualizacje jednym przyciskiem (przeniesione z Do Pierwszego).
// Gdy część androidowa się nie zmieniła, apka pobiera samą stronę (plan-www.zip) i przeładowuje się.
// Gdy się zmieniła, pobiera całe APK i instaluje je w tle (Android 12+ nie pyta o zgodę).

const RELEASE_API = 'https://api.github.com/repos/Loop-hash/plan-app/releases/tags/latest';
// Plik z wydania — bez limitu 60 zapytań/h, który ma API (w akademiku wiele telefonów dzieli jedno IP)
const DL = 'https://github.com/Loop-hash/plan-app/releases/download/latest/';
export const RELEASE_PAGE = 'https://github.com/Loop-hash/plan-app/releases/latest';

const cap = () => (typeof window !== 'undefined' ? window.Capacitor : null);
export const isNative = () => !!(cap() && cap().isNativePlatform && cap().isNativePlatform());
const plugin = () => (isNative() && cap().Plugins ? cap().Plugins.Updater : null);
export const hasUpdater = () => !!plugin();

let buildInfo = null;
export async function currentBuild() {
  if (buildInfo) return buildInfo;
  try {
    const r = await fetch('build.json', { cache: 'no-store' });
    buildInfo = r.ok ? await r.json() : {};
  } catch (e) { buildInfo = {}; }
  return buildInfo;
}

// Informacja o najnowszej wersji z GitHuba albo null (brak internetu itp.)
export async function checkUpdate() {
  const cur = await currentBuild();
  try {
    const r = await fetch(`${DL}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) {
      const v = await r.json();
      if (v && v.build) {
        return {
          build: Number(v.build),
          current: Number(cur.build) || 0,
          newer: Number(v.build) > (Number(cur.build) || 0),
          native: v.native || '',
          apk: { url: `${DL}Plan.apk`, size: Number(v.apkSize) || 0 },
          web: { url: `${DL}plan-www.zip`, size: Number(v.webSize) || 0 },
        };
      }
    }
  } catch (e) { /* zapas: API GitHuba */ }
  const r = await fetch(RELEASE_API, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub odpowiedział ${r.status}`);
  const rel = await r.json();
  const body = rel.body || '';
  const build = Number((/build[:\s#]+(\d+)/i.exec(body) || [])[1] || 0);
  const native = (/native[:\s]+([0-9a-f]{6,})/i.exec(body) || [])[1] || '';
  const assets = rel.assets || [];
  const by = (n) => assets.find((a) => a.name === n);
  const apk = by('Plan.apk');
  const web = by('plan-www.zip');
  return {
    build,
    current: Number(cur.build) || 0,
    newer: build > (Number(cur.build) || 0),
    native,
    apk: apk ? { url: apk.browser_download_url, size: apk.size } : null,
    web: web ? { url: web.browser_download_url, size: web.size } : null,
  };
}

// Wywołać przy starcie: nowa strona wystartowała, stare pliki można sprzątnąć.
export function markStarted() {
  const p = plugin();
  if (!p) return;
  p.cleanup().catch(() => {});
  try { p.webReady().catch(() => {}); } catch (e) { /* starsza wersja */ }
}

// Instaluje aktualizację. onEvent({type:'progress', pct, phase} | {type:'status', state, message})
// Zwraca 'web' (zaraz przeładowanie), 'apk' (instalacja w toku) albo 'need-permission'.
export async function applyUpdate(u, onEvent = () => {}) {
  const p = plugin();
  if (!p) throw new Error('Aktualizacja działa tylko w apce na telefonie.');
  let info = {};
  try { info = (await p.info()) || {}; } catch (e) { /* */ }
  const handles = [];
  try {
    handles.push(await p.addListener('progress', (e) => onEvent({ type: 'progress', pct: e.progress, phase: e.phase })));
    handles.push(await p.addListener('status', (e) => onEvent({ type: 'status', state: e.state, message: e.message })));
  } catch (e) { /* */ }
  try {
    const sameNative = !!(u.web && u.native && info.native && u.native === info.native);
    if (sameNative && Number(info.badWeb) !== Number(u.build)) {
      await p.applyWeb({ url: u.web.url, size: u.web.size || 0, build: Number(u.build) });
      return 'web';
    }
    if (!u.apk) throw new Error('Brak pliku APK w wydaniu.');
    let can = true;
    try { can = (await p.canInstall()).allowed !== false; } catch (e) { /* */ }
    if (!can) return 'need-permission';
    await p.downloadAndInstall({ url: u.apk.url, size: u.apk.size || 0 });
    return info.silent ? 'apk-silent' : 'apk';
  } finally {
    // listenery zostają do końca instalacji APK; po stronie i tak nastąpi przeładowanie
    setTimeout(() => handles.forEach((h) => { try { h.remove(); } catch (e) { /* */ } }), 120000);
  }
}

export function openInstallSettings() {
  const p = plugin();
  if (p) return p.openInstallSettings().catch(() => {});
  return Promise.resolve();
}
