// messageHandler.js — read unread conversations and send replies via Playwright

import fs from 'fs';
import { getPage } from './browser.js';
import { config } from './config.js';
import { randomDelay, log } from './utils.js';

// ─── Selector candidates ─────────────────────────────────────────────────────
// Vinted's class names are hashed and change with each deploy, so we cast a
// wide net and log how many elements each strategy finds. That log + the HTML
// dump will let you pinpoint the real selector on your live session.

const CONVERSATION_LINK_SELECTORS = [
  'a[href*="/conversation/"]',                  // universal — catches any link to a convo
  'a[href*="/messages/"]',                      // older Vinted routing
  '[data-testid="inbox-item"] a',
  '[data-testid="conversation-item"] a',
  '.inbox__item a',
  '[class*="InboxItem"] a',
  '[class*="inbox-item"] a',
  '[class*="ConversationItem"] a',
  '[class*="conversation-item"] a',
  '[class*="thread"] a',
  '[role="listitem"] a[href*="/"]',
];

// Attributes / child elements that Vinted uses to mark a conversation unread.
// We try them all and OR the results.
const UNREAD_SIGNALS = [
  // Class-based
  (el) => el.classList.contains('is-unread'),
  (el) => el.classList.contains('unread'),
  (el) => [...el.classList].some((c) => c.toLowerCase().includes('unread')),
  // Descendant badge / dot
  (el) => el.querySelector('[class*="unread"]') !== null,
  (el) => el.querySelector('[class*="badge"]') !== null,
  (el) => el.querySelector('[class*="dot"]') !== null,
  (el) => el.querySelector('[class*="notification"]') !== null,
  // Bold text (unread convos typically show sender name in bold)
  (el) => {
    const strong = el.querySelector('strong, b');
    if (strong) return true;
    const spans = [...el.querySelectorAll('span')];
    return spans.some((s) => {
      const fw = window.getComputedStyle(s).fontWeight;
      return fw === 'bold' || parseInt(fw, 10) >= 700;
    });
  },
  // aria / data attributes
  (el) => el.getAttribute('aria-label')?.toLowerCase().includes('unread'),
  (el) => el.dataset.unread !== undefined,
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

  // Log a selector probe: try every candidate and report element counts
  log('[messageHandler][debug] Probing selectors…');
  for (const sel of CONVERSATION_LINK_SELECTORS) {
    try {
      const count = await page.$$eval(sel, (els) => els.length);
      log(`[messageHandler][debug]   "${sel}" → ${count} element(s)`);
    } catch {
      log(`[messageHandler][debug]   "${sel}" → (error)`);
    }
  }

  // Log the page URL and title to confirm we are where we think we are
  log(`[messageHandler][debug] Current URL : ${page.url()}`);
  log(`[messageHandler][debug] Page title  : ${await page.title()}`);
}

// ─── Core functions ──────────────────────────────────────────────────────────

/**
 * Navigate to the Vinted inbox and return a list of unread conversations.
 * Each entry: { conversationUrl, senderName, itemTitle, conversationId }
 *
 * Strategy:
 *  1. Go to inbox, wait for network to settle (SPA hydration).
 *  2. Wait explicitly for at least one conversation link to appear.
 *  3. Collect ALL conversation links.
 *  4. Try multiple unread-detection signals; if none fire, return ALL
 *     conversations so messages are never silently missed.
 */
export async function getUnreadConversations() {
  const page = getPage();

  log(`[messageHandler] Navigating to ${config.vintedInboxUrl}…`);
  await page.goto(config.vintedInboxUrl, {
    waitUntil: 'networkidle',   // wait for React to finish rendering
    timeout: 30000,
  });
  await randomDelay(1500, 2500); // extra buffer for lazy-loaded content

  // Wait up to 10 s for at least one conversation link to appear
  const firstSelector = CONVERSATION_LINK_SELECTORS[0]; // a[href*="/conversation/"]
  try {
    await page.waitForSelector(firstSelector, { timeout: 10000 });
  } catch {
    log('[messageHandler] WARNING: No conversation links appeared within 10 s.');
    if (config.debugInbox) await debugInbox();
    return [];
  }

  // Dump debug artefacts if requested
  if (config.debugInbox) await debugInbox();

  // ── Step 1: collect all conversation links with a working selector ──
  let rawLinks = [];
  for (const sel of CONVERSATION_LINK_SELECTORS) {
    try {
      const found = await page.$$eval(sel, (els) =>
        [...new Set(els.map((el) => el.closest('a')?.href || el.href).filter(Boolean))]
          .filter((href) => /\/conversation\/\d+|\/messages\/\d+/.test(href))
      );
      if (found.length > 0) {
        log(`[messageHandler] Selector "${sel}" found ${found.length} conversation link(s).`);
        rawLinks = found;
        break;
      }
    } catch {
      // try next
    }
  }

  if (rawLinks.length === 0) {
    log('[messageHandler] No conversation links found with any selector.');
    return [];
  }

  // ── Step 2: for each link, find its container and probe unread signals ──
  const conversations = await page.$$eval(
    CONVERSATION_LINK_SELECTORS[0],
    (anchors, signals) => {
      // signals are serialised as strings and eval'd inside the browser
      const fns = signals.map((s) => {
        try { return new Function('el', 'window', `return (${s})(el)`); } catch { return () => false; }
      });

      const seen = new Set();
      const results = [];

      for (const anchor of anchors) {
        const href = anchor.href || '';
        const idMatch = href.match(/\/(?:conversation|messages)\/(\d+)/);
        if (!idMatch || seen.has(idMatch[1])) continue;
        seen.add(idMatch[1]);

        // Walk up to the list-item container (up to 5 levels)
        let container = anchor;
        for (let i = 0; i < 5; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          if (
            container.tagName === 'LI' ||
            container.role === 'listitem' ||
            container.getAttribute('role') === 'listitem'
          ) break;
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
    UNREAD_SIGNALS.map((fn) => fn.toString())
  );

  log(`[messageHandler] Total conversations found: ${conversations.length}`);

  const unread = conversations.filter((c) => c.hasUnread);
  log(`[messageHandler] Conversations flagged as unread: ${unread.length}`);

  // ── Fallback: if unread detection returned nothing but there ARE convos,
  //    return ALL of them. main.js deduplication (handled.json) prevents
  //    double-replies, so over-fetching is safe. ──
  if (unread.length === 0 && conversations.length > 0) {
    log(
      '[messageHandler] WARNING: Unread detection returned 0 — ' +
      'returning all conversations as fallback. Check /tmp/inbox-debug.* ' +
      'to identify the real unread selector and update UNREAD_SIGNALS.'
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
