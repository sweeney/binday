// app.js — state, bootstrap and wiring.
//
// Flow: load settings, finish an OAuth callback if we are in the middle of
// one, then either show the sign-in page or render the app. When a cached
// copy of config exists the app paints from it immediately and refreshes
// behind the scenes, so opening the page costs no waiting.
//
// Everything that decides what the screen looks like lives in views.js;
// this module only decides what to show it.

import * as auth from './auth.js';
import * as api from './api.js';
import { el, replace } from './dom.js';
import { isDate, nextCollections, today } from './resolve.js';
import {
  colophonView,
  emptyView,
  heroView,
  signInView,
  sitesView,
  timetableView,
  unscheduledView,
  upcomingView,
  warningView,
} from './views.js';

// How often an open page re-reads config, and how stale the data must be
// before returning to the page is reason enough to re-read it. Schedules
// change when a council publishes festive dates, which is to say rarely —
// these are about not showing yesterday's answer, not about being live.
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;

const main = document.getElementById('main');
const accountEl = document.getElementById('account');
const colophonEl = document.getElementById('colophon');

const state = {
  sites: [],
  siteId: null,
  // The date the app is pretending it is. Normally today; the colophon lets
  // you move it to check a festive schedule without waiting for December.
  viewDate: today(),
  // True once a date has been chosen by hand, which stops the app quietly
  // snapping back to today when the tab is next brought forward.
  pinned: false,
  fetchedAt: null,
  warning: null,
};

// ── screens ─────────────────────────────────────────────────────────────

function showSignIn(message) {
  replace(accountEl, []);
  replace(colophonEl, []);
  // startLogin navigates away on success, so the only way it settles is by
  // failing — say so on the page rather than in the console.
  const onSignIn = () => {
    auth.startLogin().catch((error) => showSignIn(error.message));
  };
  replace(main, [signInView({ message, onSignIn })]);
}

function selectSite(id) {
  if (id === state.siteId) return;
  state.siteId = id;
  state.viewDate = today();
  state.pinned = false;
  location.hash = `#/${id}`;
  render();
}

function setViewDate(value) {
  if (!isDate(value)) return;
  state.viewDate = value;
  state.pinned = value !== today();
  render();
}

function render() {
  if (!state.sites.length) {
    replace(colophonEl, []);
    replace(main, [
      emptyView({
        title: 'No properties to show',
        body: 'No site in config names a bin scheme. Add a "bin_scheme" to a site in the sites namespace, and a matching entry in bin_schemes.',
      }),
    ]);
    return;
  }

  const site = state.sites.find((s) => s.id === state.siteId) || state.sites[0];
  state.siteId = site.id;

  const next = nextCollections(site.scheme, state.viewDate);
  const unscheduled = (site.scheme.bins || []).filter((bin) => !isDate(bin.anchor));

  const blocks = [
    sitesView({ sites: state.sites, activeId: site.id, onSelect: selectSite }),
    state.warning && warningView(state.warning),
  ];

  if (next.length) {
    const soonest = next[0].date;
    blocks.push(heroView(next.filter((collection) => collection.date === soonest)));

    const later = next.filter((collection) => collection.date !== soonest);
    if (later.length) blocks.push(upcomingView(later));

    blocks.push(timetableView(site.scheme, state.viewDate));
  } else {
    blocks.push(
      emptyView({
        title: 'No collection dates',
        body: `Nothing is scheduled for ${site.name} in the next four months. Check the anchor dates in the bin_schemes config.`,
      }),
    );
  }

  blocks.push(unscheduledView(unscheduled));

  replace(main, blocks);
  replace(
    colophonEl,
    colophonView({
      site,
      fetchedAt: state.fetchedAt,
      viewDate: state.viewDate,
      isToday: state.viewDate === today(),
      onDate: setViewDate,
      onToday: () => {
        state.viewDate = today();
        state.pinned = false;
        render();
      },
    }),
  );
}

async function showAccount() {
  const signOut = el('button.button-link', {
    type: 'button',
    text: 'Sign out',
    on: {
      click: async () => {
        await auth.logout();
        api.clearCache();
        showSignIn();
      },
    },
  });
  replace(accountEl, [signOut]);

  // Identity is the only place that knows who this is, and the answer is
  // cosmetic, so it is fetched after the app is already on screen.
  const user = await auth.currentUser();
  const name = user && (user.username || user.email);
  if (name) replace(accountEl, [el('span.whoami', { text: name }), signOut]);
}

// ── loading ─────────────────────────────────────────────────────────────

function siteFromHash() {
  const match = location.hash.match(/^#\/([\w-]+)$/);
  return match ? match[1] : null;
}

function adopt(data) {
  state.sites = data.sites;
  state.fetchedAt = data.fetchedAt;
  if (!state.siteId || !state.sites.some((site) => site.id === state.siteId)) {
    state.siteId = siteFromHash() || (state.sites[0] && state.sites[0].id) || null;
  }
}

async function loadAndRender() {
  // Paint from the last known schedule first. Bin days do not change often,
  // and a stale answer on screen immediately beats a correct one after a
  // round-trip — the refresh below corrects it either way.
  const cached = api.cached();
  if (cached) {
    adopt(cached);
    render();
  }

  try {
    adopt(await api.loadSites());
    state.warning = null;
  } catch (error) {
    if (error instanceof auth.SessionExpired) {
      showSignIn('Your session expired. Please sign in again.');
      return;
    }
    if (!cached) {
      replace(colophonEl, []);
      replace(main, [
        emptyView({
          title: 'Could not load the schedule',
          body: error.message,
          action: { label: 'Try again', onClick: () => loadAndRender() },
        }),
      ]);
      return;
    }
    state.warning = `Showing the last known schedule — ${error.message}`;
  }

  render();
}

// ── staying current ─────────────────────────────────────────────────────

// Re-read config without ever taking the page away from the reader.
//
// This is the difference between this and loadAndRender(): that one runs
// because someone opened the app and can reasonably be sent to a sign-in
// page. This one runs on a timer, so a failure must leave what is on screen
// alone and say so in the banner. Being quietly told the schedule is an hour
// old beats being silently signed out while looking at it.
async function refreshQuietly() {
  if (state.pinned || !auth.isSignedIn() || !state.sites.length) return;

  try {
    adopt(await api.loadSites());
    state.warning = null;
  } catch (error) {
    const reason =
      error instanceof auth.SessionExpired
        ? 'your session expired — reload to sign in again'
        : error.message;
    state.warning = `Showing the last known schedule — ${reason}`;
  }

  state.viewDate = today();
  render();
}

// True if the data on screen is old enough to be worth a round-trip.
function isStale() {
  if (!state.fetchedAt) return true;
  const age = Date.now() - Date.parse(state.fetchedAt);
  return !Number.isFinite(age) || age > STALE_AFTER_MS;
}

// Re-render at midnight, rather than letting the hourly tick discover the
// new day up to an hour late. "Today" being wrong is the one error a bin app
// cannot afford, and the fix costs no network.
function scheduleDateRollover() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);

  // A second past the hour, so today() has certainly rolled over by the time
  // this runs. A sleeping laptop fires it late, which is harmless: the date
  // is read fresh, never counted.
  setTimeout(() => {
    if (!state.pinned && auth.isSignedIn() && state.sites.length) {
      state.viewDate = today();
      render();
    }
    scheduleDateRollover();
  }, midnight - now + 1000);
}

// ── boot ────────────────────────────────────────────────────────────────

async function boot() {
  try {
    await auth.completeLogin();
  } catch (error) {
    showSignIn(error.message);
    return;
  }

  if (!auth.isSignedIn()) {
    showSignIn();
    return;
  }

  showAccount();
  await loadAndRender();

  // An open page re-reads config on the hour. This is the case of a page left
  // in front of someone — a tablet on a wall, a tab on a desktop — where
  // nothing else would ever prompt a re-read.
  setInterval(() => {
    if (isStale()) refreshQuietly();
  }, REFRESH_INTERVAL_MS);

  scheduleDateRollover();

  // Coming back to the page is the moment that matters on a phone, where the
  // app is resumed rather than reloaded and background timers are throttled
  // or suspended outright. Fix the date immediately — it is free — and re-read
  // config only if what we hold has gone stale.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!auth.isSignedIn() || !state.sites.length || state.pinned) return;

    if (state.viewDate !== today()) {
      state.viewDate = today();
      render();
    }
    if (isStale()) refreshQuietly();
  });

  addEventListener('hashchange', () => {
    const id = siteFromHash();
    if (id && id !== state.siteId && state.sites.some((site) => site.id === id)) {
      state.siteId = id;
      render();
    }
  });
}

boot();
