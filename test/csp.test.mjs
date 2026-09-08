// The Content-Security-Policy lives in index.html now, by hand, rather than
// being derived from configuration by a server. That makes it possible for
// the policy and the settings to drift apart — and the failure mode is
// nasty: sign-in or every schedule read is blocked by the browser, with the
// reason only in the console. So the agreement is a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { settings } from '../static/settings.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const policy = (() => {
  const match = html.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
  );
  assert.ok(match, 'index.html has no Content-Security-Policy meta tag');
  return Object.fromEntries(
    match[1].split(';').map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
})();

test('connect-src names every origin the app talks to', () => {
  for (const origin of [settings.identity_url, settings.config_url]) {
    assert.ok(
      policy['connect-src'].includes(origin),
      `connect-src is missing ${origin}; the browser would block every request to it`,
    );
  }
  assert.ok(policy['connect-src'].includes("'self'"), "connect-src is missing 'self'");
});

test('form-action allows identity, which the authorize flow posts back through', () => {
  assert.ok(policy['form-action'].includes(settings.identity_url));
});

test('scripts and styles are pinned to this origin', () => {
  assert.deepEqual(policy['script-src'], ["'self'"]);
  assert.deepEqual(policy['style-src'], ["'self'"]);
  assert.deepEqual(policy['default-src'], ["'self'"]);
  assert.deepEqual(policy['base-uri'], ["'self'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
});

test('nothing unsafe has crept in', () => {
  const raw = html.toLowerCase();
  assert.ok(!raw.includes('unsafe-inline'), 'CSP allows unsafe-inline');
  assert.ok(!raw.includes('unsafe-eval'), 'CSP allows unsafe-eval');
});

// Browsers ignore frame-ancestors in a meta tag and log a console warning
// for it. Its absence is deliberate and documented in index.html; this test
// stops someone "fixing" it by adding a directive that does nothing.
test('frame-ancestors is not pretended at', () => {
  assert.ok(
    !('frame-ancestors' in policy),
    'frame-ancestors has no effect in a meta tag — leave it out and keep the comment explaining why',
  );
});

test('the OAuth code cannot leak through a Referer', () => {
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

// The published site is served at the domain root, so absolute /static/
// paths resolve. A stray relative path would work locally from the repo
// root and break nowhere else — which is the worst kind of bug.
test('index.html references its assets absolutely', () => {
  const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const reference of references) {
    if (reference.startsWith('data:') || reference.startsWith('http')) continue;
    assert.ok(
      reference.startsWith('/static/'),
      `${reference} should be an absolute /static/ path`,
    );
  }
});
