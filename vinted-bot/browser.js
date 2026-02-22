// browser.js — Playwright session management
// Run with: node browser.js --save-session   (to log in manually and save cookies)

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { log } from './utils.js';

let browser = null;
let context = null;
let page = null;

/**
 * Load a saved Playwright browser context from the session file.
 * Throws SESSION_EXPIRED if the file is missing or has no refresh_token_web cookie.
 * Actual token validity is discovered lazily — the polling loop handles expiry.
 */
export async function loadSession() {
  if (!fs.existsSync(config.sessionFile)) {
    throw new Error(
      'SESSION_EXPIRED: No session file found. Run  node browser.js --save-session  to log in manually.'
    );
  }

  const storageState = JSON.parse(fs.readFileSync(config.sessionFile, 'utf8'));
  const hasRefreshToken = storageState.cookies?.some((c) => c.name === 'refresh_token_web' && c.value);
  if (!hasRefreshToken) {
    throw new Error(
      'SESSION_EXPIRED: session.json has no refresh_token_web cookie. Run  node browser.js --save-session  to log in again.'
    );
  }

  browser = await chromium.launch({
    headless: true,
    proxy: {
      server: 'http://geo.iproyal.com:12321',
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    },
  });
  context = await browser.newContext({
    storageState,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    proxy: {
      server: 'http://geo.iproyal.com:12321',
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    },
  });

  page = await context.newPage();
  return page;
}

/**
 * Return the currently active page.
 */
export function getPage() {
  return page;
}

/**
 * Close the browser cleanly.
 */
export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

/**
 * Refresh the Vinted session by exchanging the stored refresh_token_web cookie
 * for a new access token via the Vinted token API.
 * Updates both session.json on disk and the live browser context if running.
 * Returns true on success, false on failure.
 */
export async function refreshSession() {
  if (!fs.existsSync(config.sessionFile)) {
    log('[browser] refreshSession: session file not found — skipping.');
    return false;
  }

  const storageState = JSON.parse(fs.readFileSync(config.sessionFile, 'utf8'));
  const refreshCookie = storageState.cookies?.find((c) => c.name === 'refresh_token_web');

  if (!refreshCookie?.value) {
    log('[browser] refreshSession: refresh_token_web cookie not found — skipping.');
    return false;
  }

  try {
    log('[browser] Refreshing session token…');
    const response = await fetch(`${config.vintedBaseUrl}/api/v2/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshCookie.value }),
    });

    if (!response.ok) {
      log(`[browser] Token refresh failed: HTTP ${response.status}`);
      return false;
    }

    const data = await response.json();
    const domain = `.${process.env.VINTED_DOMAIN || 'vinted.be'}`;

    // Patch the access_token_web and refresh_token_web cookies in the stored state
    const upsertCookie = (name, value) => {
      const idx = storageState.cookies.findIndex((c) => c.name === name);
      if (idx >= 0) {
        storageState.cookies[idx] = { ...storageState.cookies[idx], value };
      } else {
        storageState.cookies.push({ name, value, domain, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
      }
    };

    if (data.access_token)  upsertCookie('access_token_web',  data.access_token);
    if (data.refresh_token) upsertCookie('refresh_token_web', data.refresh_token);

    fs.writeFileSync(config.sessionFile, JSON.stringify(storageState, null, 2), 'utf8');

    // Also push the new cookies into the live browser context so the running
    // session benefits immediately without needing a restart.
    if (context) {
      const liveCookies = [];
      if (data.access_token)  liveCookies.push({ name: 'access_token_web',  value: data.access_token,  domain, path: '/' });
      if (data.refresh_token) liveCookies.push({ name: 'refresh_token_web', value: data.refresh_token, domain, path: '/' });
      if (liveCookies.length) await context.addCookies(liveCookies);
    }

    log('[browser] Session token refreshed successfully.');
    return true;
  } catch (err) {
    log(`[browser] Token refresh error: ${err.message}`);
    return false;
  }
}

// ─── CLI helper: log in manually and save the session ───────────────────────
if (process.argv.includes('--save-session')) {
  (async () => {
    console.log('[browser] Opening browser for manual login…');
    const b = await chromium.launch({
      headless: false,
      proxy: {
        server: 'http://geo.iproyal.com:12321',
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      },
    });
    const ctx = await b.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      proxy: {
        server: 'http://geo.iproyal.com:12321',
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
      },
    });
    const p = await ctx.newPage();
    await p.goto('https://www.vinted.fr/login');

    console.log('[browser] Log in to Vinted in the browser window, then press ENTER here to save the session.');
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once('data', resolve));

    const sessionDir = path.dirname(config.sessionFile);
    if (sessionDir !== '.') fs.mkdirSync(sessionDir, { recursive: true });
    await ctx.storageState({ path: config.sessionFile });
    console.log(`[browser] Session saved to ${config.sessionFile}`);
    await b.close();
    process.exit(0);
  })();
}
