// Tests for the schedule resolver.
//
// Run with `node --test` from the repository root. No dependencies.
//
// Two kinds of test live here. The fixture tests pin down exception
// precedence and date arithmetic using a minimal invented scheme, so they
// keep passing when a real council changes its calendar. The snapshot tests
// run against test/fixtures/bin_schemes.json — a copy of the live config
// namespace — and assert the dates a person could check against a printed
// council calendar. A silently wrong bin app is worse than no bin app, so
// the real schedules are worth pinning even though the fixture is a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  addDays,
  collectionsInWindow,
  countdown,
  daysBetween,
  describe,
  isDate,
  nextCollections,
} from '../static/resolve.js';

const live = JSON.parse(readFileSync(new URL('./fixtures/bin_schemes.json', import.meta.url)));
const edinburgh = live.schemes.edinburgh;
const highland = live.schemes.highland;

const datesFor = (scheme, binId, from, to) =>
  collectionsInWindow(scheme, from, to)
    .filter((collection) => collection.bin.id === binId)
    .map((collection) => collection.date);

// A single-bin scheme, so precedence tests do not depend on real dates.
const fixture = ({ schemeExceptions = [], binExceptions = [], bin = {} } = {}) => ({
  name: 'Test Council',
  exceptions: schemeExceptions,
  bins: [
    {
      id: 'grey',
      label: 'Grey bin',
      colour: '#4A4A4A',
      description: 'Non-recyclable waste',
      anchor: '2026-09-07', // a Monday
      weeks: 2,
      exceptions: binExceptions,
      ...bin,
    },
  ],
});

// ── date arithmetic ─────────────────────────────────────────────────────

test('addDays and daysBetween are inverses across a BST boundary', () => {
  // BST ended on 25 October 2026. A local-time difference across that date
  // is 13.958 days, which rounds the wrong way half the time.
  assert.equal(addDays('2026-10-19', 14), '2026-11-02');
  assert.equal(daysBetween('2026-10-19', '2026-11-02'), 14);
});

test('daysBetween is negative looking backwards', () => {
  assert.equal(daysBetween('2026-09-10', '2026-09-08'), -2);
});

test('isDate rejects what Date.parse would otherwise accept', () => {
  assert.ok(isDate('2026-09-08'));
  assert.ok(!isDate('2026-9-8'));
  assert.ok(!isDate('8 September 2026'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate(null));
  assert.ok(!isDate(undefined));
});

// ── series expansion ────────────────────────────────────────────────────

test('expands a fortnightly series from its anchor', () => {
  assert.deepEqual(datesFor(fixture(), 'grey', '2026-09-07', '2026-10-20'), [
    '2026-09-07',
    '2026-09-21',
    '2026-10-05',
    '2026-10-19',
  ]);
});

test('an anchor years in the past still lands on the right weekday', () => {
  const scheme = fixture({ bin: { anchor: '2015-01-05' } }); // a Monday
  const dates = datesFor(scheme, 'grey', '2026-09-01', '2026-12-01');
  assert.ok(dates.length > 0);
  for (const date of dates) {
    assert.equal(new Date(`${date}T00:00:00Z`).getUTCDay(), 1, `${date} should be a Monday`);
  }
});

test('a bin with no anchor yields nothing rather than throwing', () => {
  assert.deepEqual(datesFor(fixture({ bin: { anchor: null } }), 'grey', '2026-01-01', '2027-01-01'), []);
});

test('a malformed interval yields nothing rather than looping forever', () => {
  for (const weeks of [0, -2, 'two', null, 1.5]) {
    assert.deepEqual(
      datesFor(fixture({ bin: { weeks } }), 'grey', '2026-09-01', '2026-12-01'),
      [],
      `weeks: ${weeks}`,
    );
  }
});

test('an inverted window returns nothing', () => {
  assert.deepEqual(collectionsInWindow(fixture(), '2026-10-01', '2026-09-01'), []);
});

test('a missing or malformed scheme returns nothing', () => {
  assert.deepEqual(collectionsInWindow(undefined, '2026-09-01', '2026-10-01'), []);
  assert.deepEqual(collectionsInWindow({}, '2026-09-01', '2026-10-01'), []);
});

// ── exceptions ──────────────────────────────────────────────────────────

test('a moved collection reports its new date and remembers the old one', () => {
  const scheme = fixture({ schemeExceptions: [{ date: '2026-09-21', movedTo: '2026-09-23' }] });
  const [, second] = collectionsInWindow(scheme, '2026-09-07', '2026-09-30');
  assert.equal(second.date, '2026-09-23');
  assert.equal(second.movedFrom, '2026-09-21');
  assert.equal(second.scheduled, '2026-09-21');
});

test('a collection can move backwards, as Highland moves Mondays to the Saturday before', () => {
  const scheme = fixture({ schemeExceptions: [{ date: '2026-12-28', movedTo: '2026-12-26' }] });
  assert.ok(datesFor(scheme, 'grey', '2026-12-01', '2027-01-05').includes('2026-12-26'));
});

test('a backwards move stops being upcoming once it has passed', () => {
  const scheme = fixture({ schemeExceptions: [{ date: '2026-12-28', movedTo: '2026-12-26' }] });
  // On the 27th that collection has already happened, even though the date
  // the interval produced is still in the future.
  const next = nextCollections(scheme, '2026-12-27').find((c) => c.bin.id === 'grey');
  assert.equal(next.date, '2027-01-11');
});

test('a skipped collection disappears with no replacement', () => {
  const scheme = fixture({ schemeExceptions: [{ date: '2026-09-21', skip: true }] });
  assert.deepEqual(datesFor(scheme, 'grey', '2026-09-07', '2026-10-06'), ['2026-09-07', '2026-10-05']);
});

test('a suspension clears its range and the series resumes on the far side', () => {
  const scheme = fixture({ binExceptions: [{ from: '2026-12-15', to: '2027-01-13', suspend: true }] });
  assert.deepEqual(datesFor(scheme, 'grey', '2026-12-01', '2027-02-01'), ['2026-12-14', '2027-01-25']);
});

test('a move with no destination leaves the collection where it was', () => {
  // A typo in config must not delete a collection silently.
  const scheme = fixture({ schemeExceptions: [{ date: '2026-09-21', movedTo: 'next Tuesday' }] });
  assert.ok(datesFor(scheme, 'grey', '2026-09-07', '2026-09-30').includes('2026-09-21'));
});

// ── precedence ──────────────────────────────────────────────────────────

test('a suspended bin is not dragged onto a shifted holiday date', () => {
  const scheme = fixture({
    binExceptions: [{ from: '2026-12-20', to: '2027-01-05', suspend: true }],
    schemeExceptions: [{ date: '2026-12-28', movedTo: '2026-12-30' }],
  });
  assert.deepEqual(
    datesFor(scheme, 'grey', '2026-12-20', '2027-01-05'),
    [],
    'the suspension must win over the scheme-wide move',
  );
});

test('a bin-level move overrides a scheme-level move on the same date', () => {
  const scheme = fixture({
    binExceptions: [{ date: '2026-09-21', movedTo: '2026-09-19' }],
    schemeExceptions: [{ date: '2026-09-21', movedTo: '2026-09-24' }],
  });
  const dates = datesFor(scheme, 'grey', '2026-09-07', '2026-09-30');
  assert.ok(dates.includes('2026-09-19'));
  assert.ok(!dates.includes('2026-09-24'));
});

test('scheme exceptions still apply to bins with no rules of their own', () => {
  const scheme = fixture({ schemeExceptions: [{ date: '2026-09-21', movedTo: '2026-09-24' }] });
  assert.ok(datesFor(scheme, 'grey', '2026-09-07', '2026-09-30').includes('2026-09-24'));
});

// ── the query the app actually makes ────────────────────────────────────

test('nextCollections returns one entry per bin, nearest first', () => {
  const next = nextCollections(highland, '2026-09-08');
  assert.deepEqual(
    next.map((c) => [c.bin.id, c.date, c.daysAway]),
    [
      ['grey', '2026-09-14', 6],
      ['blue', '2026-09-21', 13],
      ['green', '2026-10-05', 27],
    ],
  );
});

test('unscheduled bins are omitted rather than shown as unknown', () => {
  assert.deepEqual(nextCollections(fixture({ bin: { anchor: null } }), '2026-09-08'), []);
});

test('a bin due beyond the horizon is omitted', () => {
  const scheme = fixture({ bin: { anchor: '2026-09-07', weeks: 52 } });
  assert.deepEqual(nextCollections(scheme, '2026-09-08', 30), []);
});

test('day counts survive the end of British Summer Time', () => {
  const scheme = fixture({ bin: { anchor: '2026-10-19' } });
  const [next] = nextCollections(scheme, '2026-10-20');
  assert.equal(next.date, '2026-11-02');
  assert.equal(next.daysAway, 13);
});

// ── phrasing ────────────────────────────────────────────────────────────

test('countdown reads naturally at nought, one and many', () => {
  assert.equal(countdown(0), 'today');
  assert.equal(countdown(1), 'tomorrow');
  assert.equal(countdown(6), 'in 6 days');
});

test('describe names the bin and when it goes out', () => {
  const bin = { label: 'Grey bin' };
  assert.equal(describe({ bin, daysAway: 0 }), 'Grey bin TODAY');
  assert.equal(describe({ bin, daysAway: 1 }), 'Grey bin tomorrow');
  assert.equal(describe({ bin, daysAway: 6 }), 'Grey bin in 6 days');
});

// ── the live schemes ────────────────────────────────────────────────────

test('the weekly Edinburgh services stay on Tuesdays', () => {
  for (const id of ['sacks', 'food']) {
    const dates = datesFor(edinburgh, id, '2026-09-08', '2026-11-01');
    assert.ok(dates.length > 0, id);
    for (const date of dates) {
      assert.equal(new Date(`${date}T00:00:00Z`).getUTCDay(), 2, `${id} on ${date}`);
    }
  }
});

test('the two Edinburgh boxes alternate Fridays and never share a date', () => {
  const mixed = datesFor(edinburgh, 'mixed', '2026-09-08', '2026-12-01');
  const glass = datesFor(edinburgh, 'glass', '2026-09-08', '2026-12-01');
  for (const date of [...mixed, ...glass]) {
    assert.equal(new Date(`${date}T00:00:00Z`).getUTCDay(), 5, `${date} should be a Friday`);
  }
  assert.equal(mixed.filter((date) => glass.includes(date)).length, 0);
});

test('the Edinburgh garden bin reproduces the printed Tue_2 calendar', () => {
  // Every date on the 2025/26 garden waste calendar, including the two
  // December collections it omits for the festive pause.
  assert.deepEqual(datesFor(edinburgh, 'garden', '2025-11-01', '2026-10-31'), [
    '2025-11-04', '2025-11-18', '2025-12-02',
    '2026-01-13', '2026-01-27',
    '2026-02-10', '2026-02-24',
    '2026-03-10', '2026-03-24',
    '2026-04-07', '2026-04-21',
    '2026-05-05', '2026-05-19',
    '2026-06-02', '2026-06-16', '2026-06-30',
    '2026-07-14', '2026-07-28',
    '2026-08-11', '2026-08-25',
    '2026-09-08', '2026-09-22',
    '2026-10-06', '2026-10-20',
  ]);
});

test('the 2026/27 garden pause skips two collections and resumes on the third', () => {
  assert.deepEqual(datesFor(edinburgh, 'garden', '2026-12-01', '2027-01-31'), [
    '2026-12-01',
    '2027-01-12',
    '2027-01-26',
  ]);
});

test('the four-weekly Highland bins do not drift', () => {
  assert.deepEqual(datesFor(highland, 'blue', '2026-09-21', '2027-01-01'), [
    '2026-09-21',
    '2026-10-19',
    '2026-11-16',
    '2026-12-14',
  ]);
});

// ── config integrity ────────────────────────────────────────────────────

test('bin ids are unique within every live scheme', () => {
  for (const [name, scheme] of Object.entries(live.schemes)) {
    const ids = scheme.bins.map((bin) => bin.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate bin id in ${name}`);
  }
});

test('every live bin has a colour, a label and a usable interval', () => {
  for (const [name, scheme] of Object.entries(live.schemes)) {
    for (const bin of scheme.bins) {
      assert.match(bin.colour, /^#[0-9A-Fa-f]{6}$/, `${name}/${bin.id} colour`);
      assert.ok(bin.label, `${name}/${bin.id} label`);
      assert.ok(Number.isInteger(bin.weeks) && bin.weeks > 0, `${name}/${bin.id} weeks`);
      assert.ok(bin.anchor === null || isDate(bin.anchor), `${name}/${bin.id} anchor`);
    }
  }
});
