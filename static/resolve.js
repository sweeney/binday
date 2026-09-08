// resolve.js — turns a bin scheme into dates.
//
// A scheme is a council's ruleset, as stored in the `bin_schemes` config
// namespace: a name, a list of bins, and any disruptions that affect all of
// them. A bin's schedule is one known date (`anchor`) plus an interval in
// weeks. The weekday is derived from the anchor and never stored, so the two
// cannot drift apart.
//
// Dates are 'YYYY-MM-DD' strings throughout. That format sorts and compares
// correctly as a string, and all arithmetic goes through UTC, so British
// Summer Time cannot shift a collection by a day.

const DAY_MS = 86_400_000;

/** Days after an ISO date, as an ISO date. */
export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from one ISO date to another. Negative if `to` is earlier. */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Today, in the browser's local timezone, as an ISO date. */
export function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True if `date` is a real calendar date in 'YYYY-MM-DD' form.
 *
 * The round-trip is the point: Date.parse is lenient enough to turn
 * '2026-02-30' into 2 March, and a config typo that silently becomes a
 * different day is exactly the failure this app cannot afford.
 */
export function isDate(date) {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

// ── The unexceptional series ────────────────────────────────────────────

// Every date the bin's interval produces inside the window, before any
// disruption is applied. A bin with no anchor has no schedule yet and
// yields nothing — better an omission than an invented date.
function baseSeries(bin, from, to) {
  if (!isDate(bin.anchor)) return [];

  const step = Number(bin.weeks) * 7;
  if (!Number.isInteger(step) || step < 1) return [];

  // Jump straight to the first occurrence on or after `from` rather than
  // stepping from the anchor: an anchor ten years back would otherwise
  // cost hundreds of iterations on every render.
  const gap = daysBetween(bin.anchor, from);
  const skipped = gap > 0 ? Math.ceil(gap / step) : 0;

  const dates = [];
  for (let d = addDays(bin.anchor, skipped * step); d <= to; d = addDays(d, step)) {
    dates.push(d);
  }
  return dates;
}

// ── Disruptions ─────────────────────────────────────────────────────────

const suspends = (rule, date) =>
  rule.suspend === true && isDate(rule.from) && isDate(rule.to) && date >= rule.from && date <= rule.to;

// Apply one level of exceptions to a list of collections.
//
// Returns the surviving collections plus the set of scheduled dates a rule
// actually spoke to. The caller needs that set to enforce precedence: a
// date already settled at bin level must not be reconsidered at scheme
// level, or a suspended garden bin gets dragged onto a shifted holiday date
// and reappears.
function applyExceptions(collections, exceptions) {
  const settled = new Set();
  const surviving = [];

  for (const collection of collections) {
    const { scheduled } = collection;

    if (exceptions.some((rule) => suspends(rule, scheduled))) {
      settled.add(scheduled);
      continue;
    }

    const rule = exceptions.find((r) => r.date === scheduled);
    if (!rule) {
      surviving.push(collection);
      continue;
    }

    settled.add(scheduled);
    if (rule.skip === true) continue;
    if (!isDate(rule.movedTo)) {
      // A malformed rule should not silently delete a collection.
      surviving.push(collection);
      continue;
    }

    surviving.push({
      ...collection,
      date: rule.movedTo,
      movedFrom: scheduled,
      note: rule.note,
    });
  }

  return { surviving, settled };
}

// Moves can push a collection across a window edge in either direction —
// Highland pulls Monday collections back to the preceding Saturday — so the
// series is expanded past the window and filtered afterwards on the
// resolved date.
const MARGIN_DAYS = 31;

/**
 * Every collection in the scheme falling between two ISO dates, inclusive,
 * sorted by resolved date then bin id.
 *
 * Each result is `{ bin, date, scheduled, movedFrom?, note? }` — `date` is
 * when the bin actually goes out, `scheduled` is where the interval put it.
 */
export function collectionsInWindow(scheme, from, to) {
  if (!scheme || !Array.isArray(scheme.bins)) return [];
  if (!isDate(from) || !isDate(to) || from > to) return [];

  const schemeRules = Array.isArray(scheme.exceptions) ? scheme.exceptions : [];
  const results = [];

  for (const bin of scheme.bins) {
    const dates = baseSeries(bin, addDays(from, -MARGIN_DAYS), addDays(to, MARGIN_DAYS));
    const scheduled = dates.map((date) => ({ bin, date, scheduled: date }));

    // A bin's own rules are applied first and win outright.
    const binRules = Array.isArray(bin.exceptions) ? bin.exceptions : [];
    const binPass = applyExceptions(scheduled, binRules);

    const decided = binPass.surviving.filter((c) => binPass.settled.has(c.scheduled));
    const open = binPass.surviving.filter((c) => !binPass.settled.has(c.scheduled));
    const schemePass = applyExceptions(open, schemeRules);

    for (const collection of [...decided, ...schemePass.surviving]) {
      if (collection.date >= from && collection.date <= to) results.push(collection);
    }
  }

  return results.sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.bin.id < b.bin.id ? -1 : 1),
  );
}

/**
 * The soonest remaining collection for each bin, from `from` onwards,
 * nearest first. Each carries `daysAway`. Bins with no schedule, and bins
 * with nothing due inside the horizon, are omitted.
 */
export function nextCollections(scheme, from, horizonDays = 120) {
  const soonest = new Map();

  for (const collection of collectionsInWindow(scheme, from, addDays(from, horizonDays))) {
    if (soonest.has(collection.bin.id)) continue;
    soonest.set(collection.bin.id, { ...collection, daysAway: daysBetween(from, collection.date) });
  }

  return [...soonest.values()].sort((a, b) => a.daysAway - b.daysAway);
}

/** How far away a collection is, in words. */
export function countdown(daysAway) {
  if (daysAway === 0) return 'today';
  if (daysAway === 1) return 'tomorrow';
  return `in ${daysAway} days`;
}

/** A one-line description of a collection, e.g. "Grey bin tomorrow". */
export function describe(collection) {
  const when = collection.daysAway === 0 ? 'TODAY' : countdown(collection.daysAway);
  return `${collection.bin.label} ${when}`;
}
