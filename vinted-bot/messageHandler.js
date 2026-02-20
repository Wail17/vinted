// messageHandler.js — read unread conversations and send replies via Playwright

import fs from 'fs';
import { getPage } from './browser.js';
import { config } from './config.js';
import { randomDelay, log } from './utils.js';

// ─── Selector candidates ─────────────────────────────────────────────────────
// Primary selector confirmed working on vinted.be (14 elements in live session).
// Fallbacks are tried in order if the primary returns nothing.

const THREAD_SELECTOR = '[class*="thread"] a';   // ← confirmed primary

const CONVERSATION_LINK_SELECTORS = [
  THREAD_SELECTOR,                              // confirmed working on vinted.be
  'a[href*="/conversation/"]',                  // universal href match
  'a[href*="/messages/"]',                      // older Vinted routing
  '[data-testid="inbox-item"] a',
  '[data-testid="conversation-item"] a',
  '.inbox__item a',
  '[class*="InboxItem"] a',
  '[class*="inbox-item"] a',
  '[class*="ConversationItem"] a',
  '[class*="conversation-item"] a',
  '[role="listitem"] a[href*="/"]',
];

// Regex matching any Vinted conversation URL:
//   /inbox/<id>  (vinted.be current format)
//   /conversation/<id>  (older format)
//   /messages/<id>  (even older)
const CONVO_URL_RE = /\/(?:inbox|conversation|messages)\/(\d+)/;

// Unread detection signals — evaluated inside the browser context.
// Each function receives the thread container element and returns true if unread.
const UNREAD_SIGNALS = [
  // Descendant badge / dot / notification indicator (most reliable on Vinted)
  (el) => el.querySelector('[class*="badge"]') !== null,
  (el) => el.querySelector('[class*="dot"]') !== null,
  (el) => el.querySelector('[class*="unread"]') !== null,
  (el) => el.querySelector('[class*="notification"]') !== null,
  // Bold title text (Vinted bolds the sender name for unread threads)
  (el) => {
    const title =
      el.querySelector('[class*="title"], [class*="sender"], [class*="name"], strong, b');
    if (!title) return false;
    if (title.tagName === 'STRONG' || title.tagName === 'B') return true;
    const fw = window.getComputedStyle(title).fontWeight;
    return fw === 'bold' || parseInt(fw, 10) >= 700;
  },
  // Class on the container itself
  (el) => [...el.classList].some((c) => c.toLowerCase().includes('unread')),
  // aria / data attributes
  (el) => el.getAttribute('aria-label')?.toLowerCase().includes('unread'),
  (el) => el.dataset.read === 'false',
];

// ─── Debug helpers ───────────────────────────────────────────────────────────

/**
 * Save a screenshot and the full page HTML to /tmp for inspection.
 * Called automatically when config.debugInbox is true.
 */
async function debugInbox() {
  const page = getPage();

  try {
    await page.screenshot({ path: '/tmp/inbox-debug.png', fullPage: true });
    log('[messageHandler][debug] Screenshot saved → /tmp/inbox-debug.png');
  } catch (err) {
    log(`[messageHandler][debug] Screenshot failed: ${err.message}`);
  }

  try {
    const html = await page.content();
    fs.writeFileSync('/tmp/inbox-debug.html', html, 'utf8');
    log('[messageHandler][debug] Full HTML saved → /tmp/inbox-debug.html');
  } catch (err) {
    log(`[messageHandler][debug] HTML dump failed: ${err.message}`);
  }

  // Log current URL/title first — helps confirm redirect behaviour
  log(`[messageHandler][debug] Current URL : ${page.url()}`);
  log(`[messageHandler][debug] Page title  : ${await page.title()}`);
  log(`[messageHandler][debug] URL has conversation ID: ${/\/inbox\/\d+/.test(page.url())}`);

  // Probe every selector candidate and report element counts
  log('[messageHandler][debug] Probing selectors…');
  for (const sel of CONVERSATION_LINK_SELECTORS) {
    try {
      const count = await page.$$eval(sel, (els) => els.length);
      log(`[messageHandler][debug]   "${sel}" → ${count} element(s)`);
    } catch {
      log(`[messageHandler][debug]   "${sel}" → (error)`);
    }
  }
}

// ─── Core functions ──────────────────────────────────────────────────────────

/**
 * Navigate to the Vinted inbox and return a list of unread conversations.
 * Each entry: { conversationUrl, senderName, itemTitle, conversationId }
 *
 * Strategy:
 *  1. Go to /inbox, wait for network idle (SPA hydration).
 *  2. Vinted often redirects /inbox → /inbox/<id> (last open conversation).
 *     If that happens, navigate to /inbox again so the full thread list loads.
 *  3. Wait for THREAD_SELECTOR to appear, then collect all thread links.
 *  4. For each thread, check the unread signals on its container.
 *  5. If no threads are flagged unread, return ALL as safe fallback.
 */
export async function getUnreadConversations() {
  const page = getPage();

  log(`[messageHandler] Navigating to ${config.vintedInboxUrl}…`);
  await page.goto(config.vintedInboxUrl, { waitUntil: 'networkidle', timeout: 30000 });

  // Vinted SPA redirects /inbox → /inbox/<conversationId> (last viewed thread).
  // When that happens navigate back to the bare /inbox URL so the thread list
  // panel is the active view, not a single conversation.
  if (/\/inbox\/\d+/.test(page.url())) {
    log(`[messageHandler] Redirected to ${page.url()} — re-navigating to inbox root…`);
    await page.goto(config.vintedInboxUrl, { waitUntil: 'networkidle', timeout: 30000 });
  }

  await randomDelay(1000, 2000); // extra buffer for lazy-loaded thread list

  // Wait for the thread list to render
  try {
    await page.waitForSelector(THREAD_SELECTOR, { timeout: 10000 });
  } catch {
    log('[messageHandler] WARNING: Thread list did not appear within 10 s.');
    if (config.debugInbox) await debugInbox();
    return [];
  }

  // Dump debug artefacts if requested (after threads are visible)
  if (config.debugInbox) await debugInbox();

  // ── Step 1: verify the primary selector and count links ──
  let workingSelector = null;
  for (const sel of CONVERSATION_LINK_SELECTORS) {
    try {
      const count = await page.$$eval(
        sel,
        (els, re) => els.filter((el) => new RegExp(re).test(el.href || '')).length,
        CONVO_URL_RE.source
      );
      if (count > 0) {
        log(`[messageHandler] Selector "${sel}" matched ${count} conversation link(s).`);
        workingSelector = sel;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!workingSelector) {
    log('[messageHandler] No conversation links found with any selector.');
    return [];
  }

  // ── Step 2: extract conversations + unread status from thread containers ──
  const conversations = await page.$$eval(
    workingSelector,
    (anchors, signalStrings, convoReSource) => {
      const convoRe = new RegExp(convoReSource);
      const fns = signalStrings.map((s) => {
        try { return new Function('el', 'window', `return (${s})(el)`); } catch { return () => false; }
      });

      const seen = new Set();
      const results = [];

      for (const anchor of anchors) {
        const href = anchor.href || '';
        const idMatch = href.match(convoRe);
        if (!idMatch || seen.has(idMatch[1])) continue;
        seen.add(idMatch[1]);

        // Walk up from the <a> to find the thread container (up to 6 levels)
        let container = anchor.parentElement || anchor;
        for (let i = 0; i < 6; i++) {
          if (!container.parentElement) break;
          const parent = container.parentElement;
          // Stop at a list item or an element whose class mentions "thread"
          if (
            parent.tagName === 'LI' ||
            parent.getAttribute('role') === 'listitem' ||
            [...parent.classList].some((c) => c.toLowerCase().includes('thread'))
          ) {
            container = parent;
            break;
          }
          container = parent;
        }

        const hasUnread = fns.some((fn) => {
          try { return fn(container, window); } catch { return false; }
        });

        results.push({
          conversationUrl: href,
          conversationId: idMatch[1],
          hasUnread,
          senderName:
            container.querySelector('[class*="sender"], [class*="user"], strong, b')
              ?.textContent?.trim() || '',
          itemTitle:
            container.querySelector('[class*="item"], [class*="title"], [class*="product"]')
              ?.textContent?.trim() || '',
        });
      }

      return results;
    },
    UNREAD_SIGNALS.map((fn) => fn.toString()),
    CONVO_URL_RE.source
  );

  log(`[messageHandler] Total conversations found: ${conversations.length}`);

  const unread = conversations.filter((c) => c.hasUnread);
  log(`[messageHandler] Conversations flagged as unread: ${unread.length}`);

  // ── Fallback: if no threads are flagged unread but threads exist,
  //    return them all — handled.json deduplication prevents double-replies. ──
  if (unread.length === 0 && conversations.length > 0) {
    log(
      '[messageHandler] WARNING: No unread signals matched — returning all conversations as fallback. ' +
      'Inspect /tmp/inbox-debug.html to find the real unread indicator and refine UNREAD_SIGNALS.'
    );
    return conversations;
  }

  return unread;
}

/**
 * Open a conversation URL and extract the full message thread.
 * Returns: { senderName, itemTitle, messages: [{author, text}] }
 */
export async function readConversation(conversationUrl) {
  const page = getPage();
  await page.goto(conversationUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await randomDelay();

  // Wait for at least one message bubble to appear
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

  // Extract item title
  const itemTitle = await page
    .$eval(
      '[data-testid="item-title"], [class*="item-title"], [class*="ItemTitle"], ' +
      '[class*="item_title"], [class*="product-title"], [class*="ProductTitle"]',
      (el) => el.textContent.trim()
    )
    .catch(() => '');

  // Extract sender name
  const senderName = await page
    .$eval(
      '[data-testid="conversation-user"], [class*="conversation__user"], ' +
      '[class*="ConversationUser"], [class*="Username"], [class*="username"]',
      (el) => el.textContent.trim()
    )
    .catch(() => '');

  // Extract messages — try each bubble selector
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
 * Includes human-like delays between focus, typing, and submit.
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
      log(`[messageHandler] Found message input with selector: "${sel}"`);
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

  // Type character by character to mimic human input
  for (const char of replyText) {
    await input.type(char, { delay: Math.floor(Math.random() * 60) + 30 });
  }

  await randomDelay(800, 2000);

  // Submit via send button or Enter
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
