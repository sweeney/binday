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

  // A relaunch from the home screen resumes a page that may have been open
  // since yesterday, when "tomorrow" meant a different day.
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!auth.isSignedIn() || !state.sites.length || state.pinned) return;
    if (state.viewDate !== today()) {
      state.viewDate = today();
      render();
    }
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
