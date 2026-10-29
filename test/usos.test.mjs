import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shortBuilding, parseGroups, parsePrograms, parseCycles, parsePlan, components, isSelected, toEvent, mondayISO, isoToTs, pickCycle, codePrefix } from '../www/usos.js';

process.env.TZ = 'Europe/Warsaw';
const f = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');

const groups = parseGroups(f('groups-RIE.html'));
assert.ok(groups.length > 50, 'grupy: ' + groups.length);
const g3 = groups.find((g) => g.kod === 'ILKAIS>2(3)25_26');
assert.ok(g3, 'jest 3 semestr ang.');
assert.match(g3.nazwa, /3 semestr.*ang/);

const progs = parsePrograms(f('programs-RIE.html'));
assert.equal(progs[codePrefix(g3.kod)], 'Inżynieria lotnicza i kosmiczna');

const cycles = parseCycles(f('group-page.html'));
assert.deepEqual(cycles.map((c) => c.cdyd), ['2026/2027-Z']);
assert.equal(pickCycle(cycles, new Date(2026, 9, 29)).cdyd, '2026/2027-Z');

const sem = parsePlan(f('semester.html'));
assert.equal(sem.length, 41, 'wpisy semestralne');
const comps = components(sem);
const gd = comps.find((c) => c.name === 'Gas dynamics' && c.typeCode === 'LAB');
assert.ok(gd, 'Gas dynamics LAB');
assert.deepEqual(gd.groups.map((g) => g.group), [1, 2, 3, 4]);
const gm = comps.find((c) => c.name === 'General mechanics' && c.typeCode === 'WYK');
assert.equal(gm.groups.length, 1);
console.log('komponenty:', comps.map((c) => `${c.name} ${c.typeCode}[${c.groups.map((g) => g.group).join(',')}]`).join(' | '));

const wk = parsePlan(f('week-2026-10-26.html'));
assert.equal(wk.length, 30);
const first = wk[0];
assert.equal(first.dayIndex, 0);
assert.equal(first.startMin, 8 * 60 + 15);
assert.equal(first.endMin, 9 * 60 + 45);
assert.equal(first.room, 'C-203');
assert.equal(first.building, 'IŚE bud. C');
assert.deepEqual(first.teachers, ['Jarosław Kaczmarczyk']);
assert.equal(first.typeFull, 'wykład');
const ev = toEvent(first, isoToTs('2026-10-26'));
const d = new Date(ev.start);
assert.equal(d.getDate(), 26); assert.equal(d.getHours(), 8); assert.equal(d.getMinutes(), 15);
assert.equal(ev.location, 'C-203 · IŚE bud. C');
const rooms = wk.map((e) => e.room);
assert.ok(rooms.includes('3049 (350)'), rooms.join('|'));
assert.ok(rooms.includes('sala F'));
const blds = [...new Set(wk.map((e) => e.building))];
console.log('budynki:', blds.join(' | '));
assert.ok(blds.includes('CNT') && blds.includes('AEI') && blds.includes('CEK'));

const sel = { [gd.compId]: 2 };
const mine = wk.filter((e) => isSelected(e, sel));
assert.ok(mine.every((e) => e.compId !== gd.compId || e.group === 2));
assert.equal(mondayISO(new Date(2026, 9, 29).getTime()), '2026-10-26');
assert.equal(mondayISO(new Date(2026, 10, 1).getTime()), '2026-10-26');
console.log('OK — USOS:', groups.length, 'grup,', sem.length, 'wpisów sem.,', wk.length, 'w tygodniu');
