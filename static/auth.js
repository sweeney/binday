// auth.js — OAuth Authorization Code + PKCE against id.swee.net.
//
// Where state lives:
//   localStorage    access_token, refresh_token, token_expires_at
//   sessionStorage  pkce_verifier, oauth_state
//
// The PKCE verifier and CSRF state go in sessionStorage so a half-finished
// login dies with the tab instead of lingering. Tokens go in localStorage
// so the app survives a reload and a home-screen relaunch — the point of a
// bin app is that you open it for four seconds and close it again, and
// signing in every time would defeat that.
//
// Threat model: script injection on this origin could read the tokens. The
// mitigations are the Content-Security-Policy in index.html — `script-src
// 'self'`, no inline script, no third-party CDN — the fact that this app
// writes no user-supplied text into the DOM as markup, and the app having an
// origin of its own, so nothing else on swee.net shares this storage.

import { settings } from './settings.js';

const STORAGE = {
  access: 'bins.access_token',
  refresh: 'bins.refresh_token',
  expires: 'bins.token_expires_at',
  verifier: 'bins.pkce_verifier',
  state: 'bins.oauth_state',
};

let refreshInFlight = null;

// ── PKCE ────────────────────────────────────────────────────────────────

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength) {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ── Token storage ───────────────────────────────────────────────────────

export function accessToken() {
  return localStorage.getItem(STORAGE.access);
}

function refreshToken() {
  return localStorage.getItem(STORAGE.refresh);
}

// Validate before persisting. A malformed response would otherwise store
// the literal string "undefined" and wedge the app with no route back to a
// clean login.
function saveTokens(body) {
  if (!body || typeof body !== 'object') throw new Error('token response is not an object');
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('token response has no access_token');
  }
  if (typeof body.refresh_token !== 'string' || !body.refresh_token) {
    throw new Error('token response has no refresh_token');
  }
  if (typeof body.expires_in !== 'number' || !(body.expires_in > 0)) {
    throw new Error('token response has no usable expires_in');
  }
  localStorage.setItem(STORAGE.access, body.access_token);
  localStorage.setItem(STORAGE.refresh, body.refresh_token);
  localStorage.setItem(STORAGE.expires, String(Date.now() + body.expires_in * 1000));
}

export function clearTokens() {
  for (const key of Object.values(STORAGE)) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
}

export function isSignedIn() {
  return !!accessToken();
}

// ── Sign in ─────────────────────────────────────────────────────────────

export async function startLogin() {
  // PKCE needs SHA-256, which browsers expose only in a secure context.
  // https and http://localhost both qualify in Chrome and Firefox; Safari
  // does not exempt localhost, so local testing there needs Chrome or a
  // TLS front end. Without this the button just throws into the console.
  if (!globalThis.crypto || !crypto.subtle) {
    throw new Error(
      'Signing in needs a secure connection. Open this page over https — or, for local testing, use Chrome, which treats http://localhost as secure.',
    );
  }

  const verifier = randomString(32);
  const state = randomString(16);

  sessionStorage.setItem(STORAGE.verifier, verifier);
  sessionStorage.setItem(STORAGE.state, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: settings.client_id,
    redirect_uri: redirectURI(),
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    state,
  });
  location.href = `${settings.identity_url}/oauth/authorize?${params}`;
}

// The registered redirect URI is the bare origin with a trailing slash.
// Deriving it from location.origin keeps a local dev server working
// without a second registration, provided that origin is registered too.
function redirectURI() {
  return `${location.origin}/`;
}

/**
 * Complete a login if the current URL is an OAuth callback.
 * Returns true if one was handled, false if there was nothing to do.
 */
export async function completeLogin() {
  const params = new URLSearchParams(location.search);

  // Identity reports a refusal on the redirect rather than in the token
  // exchange, so surface it here instead of falling through silently.
  const failure = params.get('error');
  if (failure) {
    cleanURL();
    sessionStorage.removeItem(STORAGE.verifier);
    sessionStorage.removeItem(STORAGE.state);
    throw new Error(params.get('error_description') || failure);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return false;

  const expected = sessionStorage.getItem(STORAGE.state);
  const verifier = sessionStorage.getItem(STORAGE.verifier);
  cleanURL();

  if (state !== expected) throw new Error('Sign-in state did not match — starting again is safest');
  if (!verifier) throw new Error('Sign-in could not be completed in this tab — please try again');

  const response = await fetch(`${settings.identity_url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: settings.client_id,
      code,
      redirect_uri: redirectURI(),
      code_verifier: verifier,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Sign-in failed: ${body.error || response.status}`);

  saveTokens(body);
  sessionStorage.removeItem(STORAGE.verifier);
  sessionStorage.removeItem(STORAGE.state);
  return true;
}

// Strip ?code and ?state so a reload cannot replay a spent code, and so
// the code never reaches the browser's history or a Referer header.
function cleanURL() {
  history.replaceState(null, '', location.pathname + location.hash);
}

// ── Refresh ─────────────────────────────────────────────────────────────

// Concurrent 401s must not each start a rotation: the refresh token
// rotates on use, so the second would replay a spent one and trip
// identity's reuse detection, killing the whole token family.
function refresh() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const token = refreshToken();
    if (!token) return false;

    let response;
    try {
      response = await fetch(`${settings.identity_url}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: settings.client_id,
          refresh_token: token,
        }),
      });
    } catch {
      return false; // offline; the caller decides whether that is fatal
    }
    if (!response.ok) return false;

    try {
      saveTokens(await response.json());
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/** Thrown when the session is gone and the app must show the sign-in page. */
export class SessionExpired extends Error {
  constructor() {
    super('session expired');
    this.name = 'SessionExpired';
  }
}

/**
 * fetch() with a Bearer token attached, refreshing once on a 401.
 * Refreshes pre-emptively when the access token is within a minute of
 * expiry, which avoids a guaranteed round-trip on almost every cold start.
 */
export async function authedFetch(url, options = {}) {
  if (!accessToken()) throw new SessionExpired();

  const expiresAt = Number(localStorage.getItem(STORAGE.expires) || 0);
  if (expiresAt && Date.now() > expiresAt - 60_000) {
    await refresh();
  }

  const send = () =>
    fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${accessToken()}` },
    });

  const response = await send();
  if (response.status !== 401) return response;

  if (!(await refresh())) {
    clearTokens();
    throw new SessionExpired();
  }
  return send();
}

// ── Sign out ────────────────────────────────────────────────────────────

export async function logout() {
  const access = accessToken();
  const token = refreshToken();

  // Identity's logout is auth-gated: it identifies the session from the
  // access token and revokes the refresh token it is given. Best effort —
  // clearing local state is what actually signs this browser out.
  if (access && token) {
    try {
      await fetch(`${settings.identity_url}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
        body: JSON.stringify({ refresh_token: token }),
      });
    } catch {
      /* offline — the local clear below is the source of truth */
    }
  }
  clearTokens();
}

/** The signed-in user, or null if identity will not say. */
export async function currentUser() {
  try {
    const response = await authedFetch(`${settings.identity_url}/api/v1/auth/me`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

