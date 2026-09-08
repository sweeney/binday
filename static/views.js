// views.js — everything that turns resolved collections into DOM.
//
// These functions are pure: data in, elements out, no module state and no
// network. That keeps the interesting logic — which bins get promoted, how
// a move is worded — out of the bootstrap path, and lets the whole app be
// rendered from a fixture without signing in to anything.

import { el } from './dom.js';
import { addDays, collectionsInWindow, countdown } from './resolve.js';

export const TIMETABLE_WEEKS = 12;

const formatDate = (date, options) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...options }).format(
    new Date(`${date}T00:00:00Z`),
  );

const swatch = (colour) => el('i.swatch', { vars: { '--bin': colour }, 'aria-hidden': 'true' });

// ── sign in ─────────────────────────────────────────────────────────────

export function signInView({ message, onSignIn }) {
  return el('section.card.signin', {}, [
    el('h1', { text: 'When do the bins go out?' }),
    message && el('p.warning', { text: message }),
    el('button.button', { type: 'button', text: 'Sign in with swee.net', on: { click: onSignIn } }),
  ]);
}

// ── the next collection ─────────────────────────────────────────────────

/**
 * The hero describes a day, not a bin.
 *
 * Every bin due on the soonest date is promoted together, so a second bin
 * due today can never hide in the list below — the one mistake this app
 * must not make. `due` is the collections sharing that date.
 */
export function heroView(due) {
  const { daysAway, date } = due[0];
  const several = due.length > 1;
  const it = several ? 'them' : 'it';

  const count = daysAway === 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : String(daysAway);

  // An instruction while there is still something to do about it; a plain
  // distance once there is not.
  const unit =
    daysAway === 0 ? `Put ${it} out now` : daysAway === 1 ? `Put ${it} out tonight` : 'days away';

  const moved = due.find((collection) => collection.movedFrom);
  const notes = due.filter((collection) => collection.note);

  return el('section.card.hero', { 'data-count': due.length }, [
    el(
      'div.stripe',
      { 'aria-hidden': 'true' },
      due.map((collection) => el('span', { vars: { '--bin': collection.bin.colour } })),
    ),
    el('div.hero-body', {}, [
      el('p.count', {}, [count, el('span.unit', { text: unit })]),
      ...due.map((collection) =>
        el('div.hero-bin', {}, [
          el('h2.name', {}, [several && swatch(collection.bin.colour), collection.bin.label]),
          collection.bin.description && el('p.contents', { text: collection.bin.description }),
        ]),
      ),
      el('p.when', {}, [
        formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' }),
        moved &&
          el('span.moved', {
            text: ` — moved from ${formatDate(moved.movedFrom, { day: 'numeric', month: 'short' })}`,
          }),
      ]),
      ...notes.map((collection) => el('p.note', { text: collection.note })),
    ]),
  ]);
}

/** The soonest date for every other bin, nearest first. */
export function upcomingView(later) {
  return el(
    'section.upcoming',
    {},
    later.map((collection) =>
      el('div.card.row', {}, [
        el('div.stripe', { vars: { '--bin': collection.bin.colour }, 'aria-hidden': 'true' }),
        el('div.row-body', {}, [
          el('p.label', { text: collection.bin.label }),
          collection.bin.description && el('p.contents', { text: collection.bin.description }),
        ]),
        el('div.away', {}, [
          countdown(collection.daysAway),
          el('span', {
            text: formatDate(collection.date, { weekday: 'short', day: 'numeric', month: 'short' }),
          }),
        ]),
      ]),
    ),
  );
}

// ── the timetable ───────────────────────────────────────────────────────

/** Every collection for the next few weeks, grouped by month. */
export function timetableView(scheme, from, weeks = TIMETABLE_WEEKS) {
  const collections = collectionsInWindow(scheme, from, addDays(from, weeks * 7));
  if (!collections.length) return null;

  const byDate = new Map();
  for (const collection of collections) {
    if (!byDate.has(collection.date)) byDate.set(collection.date, []);
    byDate.get(collection.date).push(collection);
  }

  const rows = [];
  let month = null;

  for (const [date, items] of byDate) {
    const thisMonth = formatDate(date, { month: 'long', year: 'numeric' });
    if (thisMonth !== month) {
      month = thisMonth;
      rows.push(el('p.month', { text: month }));
    }
    rows.push(
      el(date === from ? 'div.day.is-today' : 'div.day', {}, [
        el('span.date', { text: formatDate(date, { weekday: 'short', day: 'numeric' }) }),
        el(
          'span.chips',
          {},
          items.map((collection) =>
            el('span.chip', {}, [swatch(collection.bin.colour), collection.bin.label]),
          ),
        ),
      ]),
    );
  }

  return el('section.timetable', {}, [
    el('h2.section-title', { text: `The next ${weeks} weeks` }),
    el('div.card', {}, rows),
  ]);
}

// ── chrome ──────────────────────────────────────────────────────────────

/** The property switch. Absent with fewer than two properties. */
export function sitesView({ sites, activeId, onSelect }) {
  if (sites.length < 2) return null;

  return el(
    'div.sites',
    { role: 'group', 'aria-label': 'Choose a property' },
    sites.map((site) =>
      el('button', {
        type: 'button',
        text: site.name,
        'aria-pressed': String(site.id === activeId),
        on: { click: () => onSelect(site.id) },
      }),
    ),
  );
}

export function warningView(text) {
  return el('p.warning.banner', { text });
}

export function emptyView({ title, body, action }) {
  return el('section.card.empty', {}, [
    el('h2', { text: title }),
    el('p', { text: body }),
    action && el('button.button', { type: 'button', text: action.label, on: { click: action.onClick } }),
  ]);
}

/** A note about bins config knows of but has no schedule for. */
export function unscheduledView(bins) {
  if (!bins.length) return null;

  const names = bins.map((bin) => bin.label);
  const subject =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} have` : `${names[0]} has`;
  const them = names.length > 1 ? 'them' : 'it';

  return el('p.unscheduled', {
    text: `${subject} no dates yet. Set an anchor date in config to include ${them}.`,
  });
}

export function colophonView({ site, fetchedAt, viewDate, isToday, onDate, onToday }) {
  const parts = [];

  if (site) parts.push(el('p.council', { text: site.scheme.name || site.schemeId }));

  if (fetchedAt) {
    parts.push(
      el('p.updated', {
        text: `Schedule read from config at ${new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          day: 'numeric',
          month: 'short',
        }).format(new Date(fetchedAt))}.`,
      }),
    );
  }

  parts.push(
    el('p.preview', {}, [
      el('label', { for: 'preview-date', text: 'Show another date' }),
      el('input', {
        type: 'date',
        id: 'preview-date',
        value: viewDate,
        on: { change: (event) => onDate(event.target.value) },
      }),
      !isToday && el('button.button-link', { type: 'button', text: 'back to today', on: { click: onToday } }),
    ]),
  );

  return parts;
}
