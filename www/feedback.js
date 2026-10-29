// Zgłoszenia z apki -> Issues na GitHubie (Loop-hash/plan-app).
import { FEEDBACK_TOKEN, FEEDBACK_IMG_TOKEN } from './config.js';

const REPO = 'Loop-hash/plan-app';
const IMG_REPO = 'Loop-hash/plan-app-feedback';
const LOG_KEY = 'planapp.errlog';

// ostatnie błędy apki — dołączane do zgłoszenia, żeby nie trzeba było ich opisywać
export function logError(msg) {
  try {
    const list = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    list.push(`${new Date().toISOString().slice(0, 16)} ${String(msg).slice(0, 300)}`);
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-12)));
  } catch (e) { /* */ }
}
export function recentErrors() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => logError(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => logError(`promise: ${e.reason && (e.reason.message || e.reason)}`));
}

export const canSendDirect = () => !!FEEDBACK_TOKEN;
export const canAttach = () => !!(FEEDBACK_TOKEN && FEEDBACK_IMG_TOKEN);

// zmniejsza zrzut ekranu do JPEG (max 1400 px), żeby szybko się wysyłał
export function shrinkImage(file, max = 1400) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Nie udało się wczytać obrazka')); };
    img.src = url;
  });
}

// wrzuca obrazek do repo ze zrzutami i zwraca link do wstawienia w zgłoszenie
async function uploadImage(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const name = `img/${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const r = await fetch(`https://api.github.com/repos/${IMG_REPO}/contents/${name}`, {
    method: 'PUT',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${FEEDBACK_IMG_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ message: 'Zrzut ekranu ze zgłoszenia', content: b64 }),
  });
  if (!r.ok) throw new Error(`zrzut ekranu: GitHub odpowiedział ${r.status}`);
  const j = await r.json();
  return j.content && j.content.download_url;
}

function buildIssue({ kind, text, who, diag, images = [] }) {
  const first = text.split('\n')[0].trim();
  const title = `[${kind === 'bug' ? 'Błąd' : 'Pomysł'}] ${first.length > 70 ? first.slice(0, 67) + '…' : first}`;
  let body = `${text.trim()}\n\n— ${who ? who.trim() : 'anonimowo'}, przez apkę`;
  if (images.length) body += `\n\n${images.map((u, i) => `![zrzut ${i + 1}](${u})`).join('\n')}`;
  if (diag) {
    body += `\n\n<details><summary>Informacje techniczne</summary>\n\n\`\`\`\n${diag}\n\`\`\`\n</details>`;
  }
  return { title, body };
}

// Zwraca {number, url} wysłanego zgłoszenia, albo {url} do otwarcia w przeglądarce, gdy brak klucza.
export async function sendFeedback(data) {
  const images = [];
  if (canAttach()) for (const d of data.shots || []) images.push(await uploadImage(d));
  const { title, body } = buildIssue({ ...data, images });
  if (!FEEDBACK_TOKEN) {
    const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 6000))}`;
    return { url, browser: true };
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${FEEDBACK_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ title, body }),
  });
  if (!r.ok) throw new Error(`GitHub odpowiedział ${r.status}`);
  const j = await r.json();
  return { number: j.number, url: j.html_url };
}

// Odpowiedź twórcy na zgłoszenie (tylko z panelu admina) — komentarz pod Issue.
export async function postReply(number, text) {
  if (!FEEDBACK_TOKEN) throw new Error('brak klucza w tej wersji apki');
  const r = await fetch(`https://api.github.com/repos/${REPO}/issues/${number}/comments`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${FEEDBACK_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ body: text.trim() }),
  });
  if (!r.ok) throw new Error(`GitHub odpowiedział ${r.status}`);
}

// Panel admina: otwarte zgłoszenia prosto z API (z kluczem — świeże, bez opóźnienia kopii).
export async function fetchOpenIssues() {
  if (!FEEDBACK_TOKEN) throw new Error('brak klucza');
  const h = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${FEEDBACK_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const r = await fetch(`https://api.github.com/repos/${REPO}/issues?state=open&per_page=50&t=${Date.now()}`, { headers: h, cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub odpowiedział ${r.status}`);
  const list = (await r.json()).filter((x) => !x.pull_request);
  await Promise.all(list.map(async (x) => {
    x.comment_list = [];
    if (!x.comments) return;
    try {
      const c = await fetch(`https://api.github.com/repos/${REPO}/issues/${x.number}/comments?t=${Date.now()}`, { headers: h, cache: 'no-store' });
      if (c.ok) x.comment_list = (await c.json()).map((y) => ({ user: y.user?.login, body: y.body, created_at: y.created_at }));
    } catch (e) { /* */ }
  }));
  return { updated: new Date().toISOString(), issues: list.map((x) => ({ number: x.number, title: x.title, created_at: x.created_at, comments: x.comments, comment_list: x.comment_list })) };
}
