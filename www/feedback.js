// Zgłoszenia z apki -> Issues na GitHubie (Loop-hash/plan-app).
import { FEEDBACK_TOKEN } from './config.js';

const REPO = 'Loop-hash/plan-app';
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

function buildIssue({ kind, text, who, diag }) {
  const first = text.split('\n')[0].trim();
  const title = `[${kind === 'bug' ? 'Błąd' : 'Pomysł'}] ${first.length > 70 ? first.slice(0, 67) + '…' : first}`;
  let body = `${text.trim()}\n\n— ${who ? who.trim() : 'anonimowo'}, przez apkę`;
  if (diag) {
    body += `\n\n<details><summary>Informacje techniczne</summary>\n\n\`\`\`\n${diag}\n\`\`\`\n</details>`;
  }
  return { title, body };
}

// Zwraca {number, url} wysłanego zgłoszenia, albo {url} do otwarcia w przeglądarce, gdy brak klucza.
export async function sendFeedback(data) {
  const { title, body } = buildIssue(data);
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
