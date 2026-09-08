// Tests for the boundary between config's shape and the app's.
//
// The `sites` namespace is shared with other swee.net apps, so it carries a
// good deal this one does not care about, and it can name a scheme that does
// not exist. resolveSites is where that is sorted out, and it is the only
// place where a change to config's shape would quietly break the app.
//
// The site documents below are invented. Real ones name actual properties
// and stay in config; only public council schedules are snapshotted into
// test/fixtures/.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSites } from '../static/api.js';

// A site as the sites namespace really stores it — including the fields
// belonging to the floorplan, climate and device apps.
const site = (overrides = {}) => ({
  id: 'town',
  name: 'Town Flat',
  latitude: 55.9,
  longitude: -3.2,
  topics: { deviceStatus: 'climate/town/device/status', observation: 'climate/town/observation' },
  floorplan_namespace: 'floorplan_town',
  devices_namespace: 'devices_town',
  bin_scheme: 'edinburgh',
  ...overrides,
});

const schemes = {
  schemes: {
    edinburgh: { name: 'City of Edinburgh Council', exceptions: [], bins: [] },
    highland: { name: 'The Highland Council', exceptions: [], bins: [] },
  },
};

test('folds a site and its scheme into what the views render', () => {
  const [resolved] = resolveSites({ sites: [site()] }, schemes);

  assert.deepEqual(Object.keys(resolved).sort(), ['id', 'name', 'scheme', 'schemeId']);
  assert.equal(resolved.id, 'town');
  assert.equal(resolved.name, 'Town Flat');
  assert.equal(resolved.schemeId, 'edinburgh');
  assert.equal(resolved.scheme, schemes.schemes.edinburgh, 'the scheme is inlined, not just named');
});

test('ignores the fields the sites namespace carries for other apps', () => {
  const [resolved] = resolveSites({ sites: [site()] }, schemes);

  for (const key of ['latitude', 'longitude', 'topics', 'floorplan_namespace', 'devices_namespace']) {
    assert.ok(!(key in resolved), `${key} should not survive into the app's shape`);
  }
});

test('drops a site that is not on a collection round', () => {
  const doc = { sites: [site(), site({ id: 'office', name: 'Office', bin_scheme: undefined })] };
  assert.deepEqual(
    resolveSites(doc, schemes).map((s) => s.id),
    ['town'],
  );
});

test('drops a site naming a scheme that does not exist', () => {
  // Better an absent property than a switcher tab that renders nothing.
  const doc = { sites: [site({ bin_scheme: 'atlantis' })] };
  assert.deepEqual(resolveSites(doc, schemes), []);
});

test('falls back to the id when a site has no name', () => {
  const [resolved] = resolveSites({ sites: [site({ name: undefined })] }, schemes);
  assert.equal(resolved.name, 'town');
});

test('keeps config order, which is what the switcher shows', () => {
  const doc = {
    sites: [site({ id: 'country', bin_scheme: 'highland' }), site({ id: 'town' })],
  };
  assert.deepEqual(
    resolveSites(doc, schemes).map((s) => s.id),
    ['country', 'town'],
  );
});

test('survives documents that are missing or the wrong shape', () => {
  for (const [sitesDoc, schemesDoc] of [
    [undefined, undefined],
    [null, schemes],
    [{}, schemes],
    [{ sites: 'not an array' }, schemes],
    [{ sites: [site()] }, {}],
    [{ sites: [site()] }, { schemes: null }],
    [{ sites: [null, site()] }, schemes],
  ]) {
    assert.doesNotThrow(() => resolveSites(sitesDoc, schemesDoc));
  }
});

test('a site with no id is dropped rather than rendered as a blank tab', () => {
  assert.deepEqual(resolveSites({ sites: [site({ id: undefined })] }, schemes), []);
});
