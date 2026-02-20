// messageHandler.js — read conversations and send replies via Playwright

import fs from 'fs';
import { getPage } from './browser.js';
import { config } from './config.js';
import { randomDelay, log } from './utils.js';

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
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Navigate to the Vinted inbox page (to activate the session cookies), then
 * call the internal API endpoint to retrieve the conversation list.
 *
 * Returns: [{ conversationUrl, conversationId, senderName, itemTitle }]
 */
export async function getUnreadConversations() {
  const page = getPage();

  // Load the inbox page first so that all session cookies are live in the
  // browser context before we make the API call.
  log(`[messageHandler] Navigating to ${config.vintedInboxUrl} to warm up session…`);
  await page.goto(config.vintedInboxUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await randomDelay(1000, 2000);

  if (config.debugInbox) await debugInbox();

  const INBOX_API = 'https://www.vinted.be/inbox?page=1&per_page=20';
  const FETCH_OPTS = {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
  };

  log(`[messageHandler] Calling inbox API: ${INBOX_API}`);
  const result = await page.evaluate(async ({ url, opts }) => {
    const r = await fetch(url, opts);
    const text = await r.text();
    console.log('status:', r.status, 'response preview:', text.slice(0, 500));
    return { status: r.status, text };
  }, { url: INBOX_API, opts: FETCH_OPTS });

  log(`[messageHandler] status: ${result.status}, preview: ${result.text.slice(0, 500)}`);

  let apiResponse;
  try {
    apiResponse = JSON.parse(result.text);
  } catch {
    log('[messageHandler] ERROR: Inbox API did not return valid JSON. See preview above.');
    return [];
  }

  log('[messageHandler] API response: ' + JSON.stringify(apiResponse, null, 2));

  const items = apiResponse.conversations || [];
  if (!Array.isArray(items) || items.length === 0) {
    log('[messageHandler] No conversations found in API response.');
    return [];
  }

  const unread = items.filter((c) => c.unread === true);
  log(`[messageHandler] ${items.length} conversation(s) total, ${unread.length} unread.`);

  return unread.map((item) => ({
    conversationId:  String(item.id),
    conversationUrl: `https://www.vinted.be/inbox/${item.id}`,
    senderName:      item.opposite_user?.login || '',
    lastMessage:     item.description || '',
  }));
}

/**
 * Fetch messages for a conversation via the Vinted inbox API.
 * GET https://www.vinted.be/inbox/{id} with JSON headers → parse messages array.
 * Returns: [{ author, text }]
 */
export async function getConversationMessages(conversationId) {
  const page = getPage();
  const url = `https://www.vinted.be/inbox/${conversationId}`;
  const FETCH_OPTS = {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
  };

  log(`[messageHandler] Fetching messages via API: ${url}`);
  const result = await page.evaluate(async ({ url, opts }) => {
    const r = await fetch(url, opts);
    const text = await r.text();
    console.log('status:', r.status, 'response preview:', text.slice(0, 500));
    return { status: r.status, text };
  }, { url, opts: FETCH_OPTS });

  log(`[messageHandler] status: ${result.status}, preview: ${result.text.slice(0, 500)}`);

  let apiResponse;
  try {
    apiResponse = JSON.parse(result.text);
  } catch {
    log(`[messageHandler] getConversationMessages: non-JSON response for ${url}`);
    return [];
  }

  const raw = apiResponse.messages || apiResponse.conversation?.messages || [];
  return raw.map((msg) => ({
    author: msg.sender?.login || msg.user?.login || msg.author || 'unknown',
    text:   msg.body || msg.text || msg.content || '',
  }));
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
