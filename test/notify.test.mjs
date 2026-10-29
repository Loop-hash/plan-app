import assert from 'node:assert/strict';
import { planReminders } from '../www/notify.js';
process.env.TZ = 'Europe/Warsaw';
const now = new Date(2026, 9, 29, 19, 0).getTime();
const exams = [
  { id: 'a', subject: 'Gas dynamics', kind: 'kolokwium', date: '2026-11-02', startMin: 615, location: 'A-318', leads: [1, 0] },
  { id: 'b', subject: 'General mechanics', kind: 'egzamin', date: '2027-01-29', leads: [1, 0] },
  { id: 'c', subject: 'Stare', kind: 'egzamin', date: '2026-10-01' },
  { id: 'd', subject: 'Wyłączone', kind: 'egzamin', date: '2026-11-10', remind: false },
];
const r = planReminders(exams, { dayBefore: true, dayBeforeMin: 1140, before: true, beforeMin: 120, morningMin: 450 }, now, (k) => k);
assert.equal(r.length, 4);
assert.equal(new Date(r[0].at).getDate(), 1); assert.equal(new Date(r[0].at).getHours(), 19);
assert.match(r[0].title, /^Jutro: kolokwium: Gas dynamics/);
assert.equal(new Date(r[1].at).getHours(), 8); assert.equal(new Date(r[1].at).getMinutes(), 15);
assert.match(r[1].title, /^Za 2 h/);
assert.equal(new Date(r[3].at).getHours(), 7); assert.equal(new Date(r[3].at).getMinutes(), 30);
assert.match(r[3].title, /^Dziś/);
assert.deepEqual(r.map((x) => x.id), [700000, 700001, 700002, 700003]);
assert.equal(planReminders([{ id: 'z', subject: 'X', kind: 'egzamin', date: '2026-11-20', leads: [] }], {}, now).length, 0);
assert.equal(planReminders([{ id: 'z', subject: 'X', kind: 'egzamin', date: '2026-11-20' }], {}, now).length, 1, 'domyślnie dzień przed');
// własne terminy przypomnień dla egzaminu: 2 tygodnie i tydzień przed
const r2 = planReminders([{ id: 'e', subject: 'Gas dynamics', kind: 'egzamin', date: '2026-12-02', leads: [14, 7] }], { dayBefore: true, dayBeforeMin: 1140, before: true }, now, (k) => k);
assert.equal(r2.length, 2);
assert.equal(new Date(r2[0].at).getDate(), 18); assert.match(r2[0].title, /^Za 2 tygodnie/);
assert.equal(new Date(r2[1].at).getDate(), 25); assert.match(r2[1].title, /^Za tydzień/);
assert.match(r2[0].body, /zacząć się uczyć/);
console.log('OK — przypomnienia');
