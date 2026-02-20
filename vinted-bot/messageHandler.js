// messageHandler.js — read conversations and send replies via Playwright

import fs from 'fs';
import { getPage } from './browser.js';
import { config } from './config.js';
import { randomDelay, log } from './utils.js';

const THREAD_SELECTOR = '[class*="thread"] a';
const INBOX_CONVO_RE  = /\/inbox\/(\d+)/;

// ─── Debug helpers ────────────────────────────────────────────────────────────

async function debugInbox() {
  const page = getPage();
  try {
    await page.screenshot({ path: '/tmp/inbox-debug.png', fullPage: true });
    log('[messageHandler][debug] Screenshot → /tmp/inbox-debug.png');
  } catch (err) {
    log(`[messageHandler][debug] Screenshot failed: ${err.message}`);
  }
  try {
    fs.writeFileSync('/tmp/inbox-debug.html', await page.content(), 'utf8');
    log('[messageHandler][debug] HTML → /tmp/inbox-debug.html');
  } catch (err) {
    log(`[messageHandler][debug] HTML dump failed: ${err.message}`);
  }
  log(`[messageHandler][debug] URL: ${page.url()}`);
  const count = await page.$$eval(THREAD_SELECTOR, (els) => els.length).catch(() => 0);
  log(`[messageHandler][debug] "${THREAD_SELECTOR}" → ${count} element(s)`);
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Navigate to the Vinted inbox and return ALL conversations found in the
 * thread list. handled.json deduplication in main.js prevents double-replies.
 *
 * Returns: [{ conversationUrl, conversationId, senderName, itemTitle }]
 */
export async function getUnreadConversations() {
  const page = getPage();

  log(`[messageHandler] Navigating to ${config.vintedInboxUrl}…`);
  await page.goto(config.vintedInboxUrl, { waitUntil: 'networkidle', timeout: 30000 });

  // Vinted SPA redirects /inbox → /inbox/<id> (last viewed thread).
  // Navigate back to the bare /inbox so the full thread list is the active view.
  if (INBOX_CONVO_RE.test(page.url())) {
    log(`[messageHandler] Redirected to ${page.url()} — re-navigating to inbox root…`);
    await page.goto(config.vintedInboxUrl, { waitUntil: 'networkidle', timeout: 30000 });
  }

  await randomDelay(1000, 2000); // let lazy-loaded threads finish rendering

  // Wait for at least one thread link to appear
  try {
    await page.waitForSelector(THREAD_SELECTOR, { timeout: 10000 });
  } catch {
    log('[messageHandler] WARNING: Thread list did not appear within 10 s.');
    if (config.debugInbox) await debugInbox();
    return [];
  }

  if (config.debugInbox) await debugInbox();

  // Collect every unique /inbox/<id> href from the thread list
  const conversations = await page.$$eval(THREAD_SELECTOR, (anchors) => {
    const seen = new Set();
    const results = [];
    for (const a of anchors) {
      const m = (a.href || '').match(/\/inbox\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      results.push({
        conversationUrl: a.href,
        conversationId: m[1],
        senderName: '',
        itemTitle: '',
      });
    }
    return results;
  });

  log(`[messageHandler] Found ${conversations.length} conversation(s).`);
  return conversations;
}

/**
 * Open a conversation URL and extract the last buyer message + sender name.
 * Returns: { senderName, itemTitle, messages: [{author, text}] }
 */
export async function readConversation(conversationUrl) {
  const page = getPage();
  await page.goto(conversationUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await randomDelay();

  // Try selectors for message bubbles from most to least specific
  const bubbleSelectors = [
    '[data-testid="message-bubble"]',
    '[class*="message__bubble"]',
    '[class*="MessageBubble"]',
    '[class*="message-bubble"]',
    '[class*="Bubble"]',
    '[class*="bubble"]',
    '[class*="Message"] p',
    '[class*="message"] p',
  ];

  let bubbleSelector = null;
  for (const sel of bubbleSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      bubbleSelector = sel;
      break;
    } catch {
      // try next
    }
  }

  if (!bubbleSelector) {
    log(`[messageHandler] WARNING: No message bubbles found in ${conversationUrl}`);
  }

  const itemTitle = await page
    .$eval(
      '[data-testid="item-title"], [class*="item-title"], [class*="ItemTitle"], ' +
      '[class*="item_title"], [class*="product-title"], [class*="ProductTitle"]',
      (el) => el.textContent.trim()
    )
    .catch(() => '');

  const senderName = await page
    .$eval(
      '[data-testid="conversation-user"], [class*="conversation__user"], ' +
      '[class*="ConversationUser"], [class*="Username"], [class*="username"]',
      (el) => el.textContent.trim()
    )
    .catch(() => '');

  let messages = [];
  if (bubbleSelector) {
    messages = await page.$$eval(bubbleSelector, (bubbles) =>
      bubbles.map((b) => {
        const isOwn =
          b.classList.contains('is-own') ||
          b.closest('[class*="own"]') !== null ||
          b.closest('[class*="sent"]') !== null ||
          b.dataset.own === 'true' ||
          b.dataset.sent === 'true';
        return { author: isOwn ? 'me' : 'buyer', text: b.textContent.trim() };
      })
    );
  }

  log(
    `[messageHandler] Read conversation: sender="${senderName}", item="${itemTitle}", ` +
    `messages=${messages.length}`
  );

  return { senderName, itemTitle, messages };
}

/**
 * Type and send a reply in the currently open conversation.
 */
export async function sendReply(replyText) {
  const page = getPage();

  const inputSelectors = [
    'textarea[data-testid="message-input"]',
    'textarea[data-testid*="input"]',
    '[contenteditable="true"][data-testid*="input"]',
    '[contenteditable="true"][class*="input"]',
    '[contenteditable="true"][class*="Input"]',
    '[contenteditable="true"][class*="composer"]',
    '[contenteditable="true"][class*="Composer"]',
    '[contenteditable="true"][aria-label]',
    'textarea[placeholder]',
    'textarea[class*="input"]',
    'textarea[class*="Input"]',
    'textarea[class*="message"]',
    'textarea[class*="Message"]',
  ];

  let input = null;
  for (const sel of inputSelectors) {
    input = await page.$(sel);
    if (input) {
      log(`[messageHandler] Found message input: "${sel}"`);
      break;
    }
  }

  if (!input) {
    throw new Error(
      'Could not find the message input field. ' +
      'Run with DEBUG_INBOX=true and inspect /tmp/inbox-debug.html.'
    );
  }

  await input.click();
  await randomDelay(500, 1200);

  for (const char of replyText) {
    await input.type(char, { delay: Math.floor(Math.random() * 60) + 30 });
  }

  await randomDelay(800, 2000);

  const sendButton = await page.$(
    '[data-testid="send-button"], [data-testid*="send"], ' +
    'button[type="submit"][class*="send"], button[class*="send"], ' +
    'button[class*="Send"], button[aria-label*="send"], button[aria-label*="envoyer"]'
  );

  if (sendButton) {
    await sendButton.click();
  } else {
    await input.press('Enter');
  }

  await randomDelay();
  log(`[messageHandler] Reply sent: "${replyText.slice(0, 80)}…"`);
}
