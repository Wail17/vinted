// browser.js — Playwright session management
// Run with: node browser.js --save-session   (to log in manually and save cookies)

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

let browser = null;
let context = null;
let page = null;

/**
 * Load a saved Playwright browser context from the session file.
 * Throws SESSION_EXPIRED if the file is missing or the session is invalid.
 */
export async function loadSession() {
  if (!fs.existsSync(config.sessionFile)) {
    throw new Error(
      'SESSION_EXPIRED: No session file found. Run  node browser.js --save-session  to log in manually.'
    );
  }

  browser = await chromium.launch({ headless: true });
  const storageState = JSON.parse(fs.readFileSync(config.sessionFile, 'utf8'));
  context = await browser.newContext({
    storageState,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
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
 * Verify the session is still alive by checking if we are logged in.
 * Returns true if valid, false if session has expired.
 */
export async function isSessionValid() {
  try {
    await page.goto(config.vintedBaseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Vinted shows a user avatar / profile icon when logged in
    const loggedIn = await page.$('[data-testid="header--profile-btn"], a[href*="/member"]');
    return loggedIn !== null;
  } catch {
    return false;
  }
}

// ─── CLI helper: log in manually and save the session ───────────────────────
if (process.argv.includes('--save-session')) {
  (async () => {
    console.log('[browser] Opening browser for manual login…');
    const b = await chromium.launch({ headless: false });
    const ctx = await b.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
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
