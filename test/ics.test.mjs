import assert from 'node:assert/strict';
import { parseICS, diffEvents, classType, normalizeUrl } from '../www/ics.js';

process.env.TZ = 'Europe/Warsaw';
const ics = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//USOS//PL',
  'BEGIN:VEVENT', 'UID:a1', 'DTSTART;TZID=Europe/Warsaw:20261019T081500', 'DTEND;TZID=Europe/Warsaw:20261019T094500',
  'RRULE:FREQ=WEEKLY;UNTIL=20261130T235959Z', 'EXDATE;TZID=Europe/Warsaw:20261102T081500',
  'SUMMARY:Mechanika płynów - Wykład', 'LOCATION:sala 312\\, CNT',
  'DESCRIPTION:Prowadzący: dr X\\ngrupa 1 bardzo długi opis który jest', '  zawinięty',
  'BEGIN:VALARM', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b2', 'DTSTART:20261029T110000Z', 'DTEND:20261029T123000Z', 'SUMMARY:Analiza matematyczna (Ćwiczenia)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c3', 'DTSTART;VALUE=DATE:20261101', 'SUMMARY:Wszystkich Świętych', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:d4', 'DTSTART:20261030T100000', 'DURATION:PT1H30M', 'SUMMARY:Laboratorium fizyki', 'STATUS:CONFIRMED', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:e5', 'DTSTART:20261030T100000', 'DURATION:PT1H', 'SUMMARY:Odwołane', 'STATUS:CANCELLED', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

const ev = parseICS(ics);
const mech = ev.filter((e) => e.uid === 'a1');
// 19.10, 26.10, (2.11 wykluczony), 9.11, 16.11, 23.11, 30.11
assert.equal(mech.length, 6, 'liczba wystąpień RRULE');
for (const e of mech) {
  const d = new Date(e.start);
  assert.equal(d.getHours(), 8, 'godzina mimo zmiany czasu: ' + d);
  assert.equal(d.getMinutes(), 15);
  assert.equal(e.end - e.start, 90 * 60000);
}
assert.equal(mech[0].location, 'sala 312, CNT');
assert.ok(mech[0].description.includes('\ngrupa 1'));
assert.ok(mech[0].description.endsWith('jest zawinięty'), mech[0].description);
const b = ev.find((e) => e.uid === 'b2');
assert.equal(new Date(b.start).getHours(), 12, 'UTC->Warszawa (CET po zmianie czasu)');
assert.ok(ev.find((e) => e.uid === 'c3').allDay);
assert.equal(ev.find((e) => e.uid === 'd4').end - ev.find((e) => e.uid === 'd4').start, 90 * 60000);
assert.ok(!ev.find((e) => e.uid === 'e5'), 'odwołane pominięte');
assert.equal(classType(mech[0]).key, 'wyk');
assert.equal(classType(b).key, 'cw');
assert.equal(classType(ev.find((e) => e.uid === 'd4')).key, 'lab');
assert.throws(() => parseICS('<html>login</html>'));
assert.equal(normalizeUrl(' webcal://x.pl/a.ics '), 'https://x.pl/a.ics');

// diff
const base = [
  { summary: 'A', start: 1000, end: 2000, location: 's1' },
  { summary: 'B', start: 3000, end: 4000, location: 's2' },
  { summary: 'C', start: 5000, end: 6000, location: '' },
];
const next = [
  { summary: 'A', start: 1000, end: 2000, location: 's9' },
  { summary: 'B', start: 3500, end: 4500, location: 's2' },
  { summary: 'D', start: 7000, end: 8000, location: '' },
];
const d = diffEvents(base, next, 0);
const types = d.map((x) => x.type).sort();
assert.deepEqual(types, ['added', 'moved', 'removed', 'room']);
assert.equal(diffEvents(base, base, 0).length, 0);
console.log('OK — wszystkie testy przeszły,', ev.length, 'zdarzeń');
