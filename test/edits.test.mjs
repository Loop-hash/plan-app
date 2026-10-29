import assert from 'node:assert/strict';
import { applyEdits, occKey, seriesKey, makePatch, expandCustom, minutesOf, dateTs } from '../www/edits.js';
process.env.TZ = 'Europe/Warsaw';
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
// ta sama seria w dwóch tygodniach (pon 8:15) + inne zajęcia
const ev = (d, h, m, h2, m2, comp, summary) => ({ uid: `${comp}-${d}`, comp, summary, location: 'A-1', start: at(2026, 10, d, h, m), end: at(2026, 10, d, h2, m2) });
const base = [ev(26, 8, 15, 9, 45, 'gm-1', 'General mechanics'), ev(2 + 31, 8, 15, 9, 45, 'gm-1', 'General mechanics'), ev(27, 10, 0, 11, 30, 'gd-4', 'Gas dynamics')];
// 2+31 = 2 listopada (Date liczy dalej)
assert.equal(new Date(base[1].start).getMonth(), 10);
assert.equal(seriesKey(base[0]), seriesKey(base[1]), 'ta sama seria w obu tygodniach');
assert.notEqual(occKey(base[0]), occKey(base[1]));

// przesunięcie co tydzień o dzień i na 10:00
const edits = { occ: {}, series: { [seriesKey(base[0])]: { dayShift: 1, startMin: 600, endMin: 690 } }, custom: [] };
let out = applyEdits(base, edits);
const moved = out.filter((e) => e.summary === 'General mechanics');
assert.equal(moved.length, 2);
for (const m of moved) { const d = new Date(m.start); assert.equal(d.getDay(), 2); assert.equal(d.getHours(), 10); assert.ok(m.edited); }
// wyjątek tylko dla jednego tygodnia: ukryte
edits.occ[occKey(base[1])] = { hidden: true };
out = applyEdits(base, edits);
assert.equal(out.filter((e) => e.summary === 'General mechanics').length, 1);
out = applyEdits(base, edits, { showHidden: true });
assert.equal(out.filter((e) => e.hidden).length, 1);

// własne zajęcia co tydzień
const custom = [{ id: 'x', summary: 'Lektorat', typeKey: 'lek', location: '3.1', date: '2026-10-29', startMin: 14 * 60, endMin: 15 * 60 + 30, weekly: true, until: '2026-11-19' }];
const cx = expandCustom(custom);
assert.equal(cx.length, 4);
assert.equal(minutesOf(cx[0].start), 840);
assert.equal(new Date(cx[3].start).getDate(), 19);
out = applyEdits(base, { custom });
assert.equal(out.length, 7);

// łatka z formularza
const p = makePatch(base[2], { dayTs: dateTs('2026-10-28'), startMin: 600, endMin: 690, location: 'B-2', summary: 'Gas dynamics' });
assert.deepEqual(p, { dayShift: 1, location: 'B-2' });
console.log('OK — edycja planu');
