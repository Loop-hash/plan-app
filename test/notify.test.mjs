import assert from 'node:assert/strict';
import { planReminders } from '../www/notify.js';
process.env.TZ = 'Europe/Warsaw';
const now = new Date(2026, 9, 29, 19, 0).getTime();
const exams = [
  { id: 'a', subject: 'Gas dynamics', kind: 'kolokwium', date: '2026-11-02', startMin: 615, location: 'A-318' },
  { id: 'b', subject: 'General mechanics', kind: 'egzamin', date: '2027-01-29' },
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
assert.equal(planReminders(exams, { dayBefore: false, before: false }, now).length, 0);
console.log('OK — przypomnienia');
