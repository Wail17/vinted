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
  await page.goto(config.vintedInboxUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay(1000, 2000);

  if (config.debugInbox) await debugInbox();

  const INBOX_API = 'https://www.vinted.be/api/v2/inbox?page=1&per_page=20';
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

  log(`[messageHandler] ${items.length} conversation(s) returned from API.`);

  // Price pattern: matches "27 €", "27,00 €", "27.50 €"
  const PRICE_RE = /(\d+[,.]?\d*)\s*€/;

  // Offer keywords that appear in description when a buyer makes a price offer.
  // The inbox API does not expose entity_type / offer objects directly, so we
  // rely on textual signals in the conversation description.
  const OFFER_KEYWORDS = ['accepterais', 'offre'];

  return items.map((item) => {
    // Log the full conversation object so we can see all available fields.
    log(`[messageHandler] conversation ${item.id} full object: ${JSON.stringify(item)}`);

    // Detect a price offer from the description text:
    //  • contains "accepterais" or "offre" (buyer proposing a price in French), OR
    //  • contains "€" together with a number (explicit price mention).
    const desc = (item.description || '').toLowerCase();
    const isOffer = OFFER_KEYWORDS.some((kw) => desc.includes(kw)) || PRICE_RE.test(desc);

    // Try to parse the offered price directly from the description (best-effort).
    // acceptOffer() will fetch the authoritative price from the conversation API.
    let offeredPrice = null;
    if (isOffer) {
      const m = PRICE_RE.exec(item.description || '');
      if (m) offeredPrice = parseFloat(m[1].replace(',', '.'));
    }

    return {
      conversationId:  String(item.id),
      conversationUrl: `https://www.vinted.be/inbox/${item.id}`,
      senderName:      item.opposite_user?.login || '',
      lastMessage:     item.description || '',
      // Item title from the API — primary source for SOP matching
      itemTitle:       item.item?.title || item.item_title || '',
      oppositeUserId:  item.opposite_user?.id   ?? null,
      // Try every known field name Vinted uses for the sender id on last_message
      lastSenderId:    item.last_message?.user_id
                    ?? item.last_message?.sender_id
                    ?? item.last_message?.from_user_id
                    ?? null,
      // Offer detection
      isOffer,
      offeredPrice,
    };
  });
}

/**
 * Return the user id of the currently logged-in seller by decoding the
 * access_token_web JWT stored in session.json.  No network call needed.
 * Returns null if the token is missing or cannot be decoded.
 */
export function getCurrentUserId() {
  try {
    const session = JSON.parse(fs.readFileSync(config.sessionFile, 'utf8'));
    const token = session.cookies?.find((c) => c.name === 'access_token_web')?.value;
    if (!token) {
      log('[messageHandler] getCurrentUserId: access_token_web not found in session.json.');
      return null;
    }
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const userId = payload.sub ?? null;
    log(`[messageHandler] getCurrentUserId: decoded userId=${userId}`);
    return userId;
  } catch (err) {
    log(`[messageHandler] getCurrentUserId: failed to decode JWT — ${err.message}`);
    return null;
  }
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
  await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await randomDelay();

  // Debug: log class names of first 3 candidate message elements to identify real selectors
  const debugClasses = await page.evaluate(() => {
    const candidates = document.querySelectorAll(
      '[class*="message"], [class*="thread"], [class*="bubble"], [class*="Message"], [class*="Thread"]'
    );
    return Array.from(candidates).slice(0, 3).map((el) => el.className);
  });
  log(`[messageHandler] readConversation debug classes: ${JSON.stringify(debugClasses)}`);

  // Try selectors for message bubbles from most to least specific
  const bubbleSelectors = [
    '[data-testid="message-bubble"]',
    '[class*="message__content"]',
    '[class*="MessageText"]',
    '[class*="message__bubble"]',
    '[class*="MessageBubble"]',
    '[class*="message-bubble"]',
    '[class*="bubble"]',
    '[class*="Bubble"]',
    '[class*="thread__message"]',
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
      '[data-testid="item-title"], [class*="ItemTitle"], [class*="item-title"], ' +
      '[class*="item_title"], [class*="product-title"], [class*="ProductTitle"], ' +
      '.conversation-header h2, .conversation-header h3, header h2, header h3',
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
        // Walk up to 3 ancestors looking for sent/outgoing/right (me) indicators
        const ownPatterns = ['sent', 'outgoing', 'right', 'is-own', 'own'];
        const buyerPatterns = ['received', 'incoming', 'left'];
        const matchesAny = (el, patterns) => {
          const cls = (el.className || '').toLowerCase();
          return patterns.some((p) => cls.includes(p));
        };

        let isOwn = b.dataset.own === 'true' || b.dataset.sent === 'true';
        let isBuyer = false;
        if (!isOwn) {
          let el = b;
          for (let i = 0; i < 4 && el; i++) {
            if (matchesAny(el, ownPatterns)) { isOwn = true; break; }
            if (matchesAny(el, buyerPatterns)) { isBuyer = true; break; }
            el = el.parentElement;
          }
        }

        // If neither class matched, default to buyer (better safe than silent)
        const author = isOwn ? 'me' : 'buyer';
        return { author, text: b.textContent.trim() };
      })
    );
  }

  // Debug: log last 3 messages with their assigned role
  const debugMsgs = messages.slice(-3).map((m) => ({
    role: m.author,
    preview: m.text.slice(0, 60),
  }));
  log(`[messageHandler] Last 3 messages: ${JSON.stringify(debugMsgs)}`);

  // Only pass buyer messages to Claude — filter out my own replies
  const buyerMessages = messages.filter((m) => m.author === 'buyer');

  log(
    `[messageHandler] Read conversation: sender="${senderName}", item="${itemTitle}", ` +
    `total=${messages.length}, buyer=${buyerMessages.length}`
  );

  return { senderName, itemTitle, messages: buyerMessages };
}

/**
 * Accept a pending offer on a conversation if the offered price meets the
 * minimum acceptable price from the SOP.
 *
 * Steps:
 *  1. GET /api/v2/conversations/{conversationId} → extract transaction_id,
 *     offer_request_id, and the offered price.
 *  2. If offerPrice >= minPrice, PUT …/accept with an empty body {}.
 *
 * Returns { offerPrice, transactionId, offerRequestId, accepted, error? }.
 * Returns { offerPrice: null, accepted: false } when no active offer is found.
 *
 * @param {string|number} conversationId
 * @param {number}        minPrice  — sop.price_minimum; offer must be >= this
 */
export async function acceptOffer(conversationId, minPrice) {
  const page = getPage();
  const baseUrl = config.vintedBaseUrl;

  const FETCH_OPTS = {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
  };

  // ── Step 1: GET conversation details ──────────────────────────────────────
  const convUrl = `${baseUrl}/api/v2/conversations/${conversationId}`;
  log(`[messageHandler] acceptOffer: GET ${convUrl}`);

  const convResult = await page.evaluate(async ({ url, opts }) => {
    const r = await fetch(url, opts);
    const text = await r.text();
    return { status: r.status, text };
  }, { url: convUrl, opts: FETCH_OPTS });

  log(`[messageHandler] acceptOffer: GET status=${convResult.status}, preview=${convResult.text.slice(0, 300)}`);

  let convData;
  try {
    convData = JSON.parse(convResult.text);
  } catch {
    log('[messageHandler] acceptOffer: non-JSON response — cannot extract offer details.');
    return { offerPrice: null, accepted: false, error: 'non-JSON response' };
  }

  log('[messageHandler] acceptOffer: full response: ' + JSON.stringify(convData, null, 2));

  // ── Step 2: Extract IDs and price (handle multiple known API shapes) ──────
  //
  // Try every documented path the Vinted API may use:
  //   response.conversation.transaction.id
  //   response.conversation.offer_requests[0].id
  //   response.transaction.id
  //   response.offer_requests[0].id
  const txnId =
    convData.conversation?.transaction?.id ??
    convData.transaction?.id ??
    null;

  const offerReqId =
    convData.conversation?.offer_requests?.[0]?.id ??
    convData.offer_requests?.[0]?.id ??
    null;

  // price can be on the offer_request or on the transaction itself
  const offerReqObj = convData.conversation?.offer_requests?.[0]
                   ?? convData.offer_requests?.[0]
                   ?? convData.conversation?.transaction?.offer_request
                   ?? convData.conversation?.transaction?.offer_requests?.[0]
                   ?? {};
  const rawPrice   = offerReqObj.price?.amount ?? offerReqObj.price ?? offerReqObj.amount ?? null;
  const offerPrice = rawPrice !== null ? parseFloat(rawPrice) : null;

  if (!txnId || !offerReqId) {
    log(`[messageHandler] acceptOffer: no active offer/transaction in conversation ${conversationId}.`);
    return { offerPrice, accepted: false };
  }

  log(`[messageHandler] acceptOffer: transactionId=${txnId}, offerRequestId=${offerReqId}, offerPrice=€${offerPrice}`);

  // Price guard — only accept if the offer meets the SOP minimum
  if (minPrice !== undefined && offerPrice !== null && offerPrice < minPrice) {
    log(`[messageHandler] acceptOffer: €${offerPrice} < minimum €${minPrice} — skipping PUT.`);
    return { offerPrice, transactionId: txnId, offerRequestId: offerReqId, accepted: false };
  }

  // ── Step 3: PUT …/accept ──────────────────────────────────────────────────
  const acceptUrl = `${baseUrl}/api/v2/transactions/${txnId}/offer_requests/${offerReqId}/accept`;
  log(`[messageHandler] acceptOffer: PUT ${acceptUrl}`);

  const acceptResult = await page.evaluate(async ({ url, opts }) => {
    const r = await fetch(url, { ...opts, method: 'PUT', body: JSON.stringify({}) });
    const text = await r.text();
    return { status: r.status, text };
  }, { url: acceptUrl, opts: FETCH_OPTS });

  log(`[messageHandler] acceptOffer: PUT status=${acceptResult.status}, response=${acceptResult.text.slice(0, 300)}`);

  const accepted = acceptResult.status >= 200 && acceptResult.status < 300;
  return { offerPrice, transactionId: txnId, offerRequestId: offerReqId, accepted };
}

/**
 * Type and send a reply in the currently open conversation.
 */
export async function sendReply(replyText) {
  const page = getPage();

  // Dismiss cookie banner before interacting
  try {
    const acceptBtn = await page.$('#onetrust-accept-btn-handler, [class*="accept-all"], button[id*="accept"]');
    if (acceptBtn) {
      await acceptBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch(e) {}
  // Also try to hide it via JS if click doesn't work
  await page.evaluate(() => {
    const sdk = document.getElementById('onetrust-consent-sdk');
    if (sdk) sdk.remove();
  });

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
