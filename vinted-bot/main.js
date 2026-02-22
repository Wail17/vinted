// main.js — orchestrator: polling loop that ties everything together

import 'dotenv/config';
import { loadSession, closeBrowser, refreshSession } from './browser.js';
import { getUnreadConversations, readConversation, sendReply, acceptOffer, getCurrentUserId } from './messageHandler.js';
import { matchSop, getClaudeReply } from './claudeAgent.js';
import { randomDelay, nextPollInterval, log, isHandled, markHandled } from './utils.js';

// Cached at startup — the seller's own Vinted user id.
// Used to definitively detect when the last message in a conversation is ours.
let currentUserId = null;

async function processConversation(conv) {
  // Night mode: no replies between 23:00 and 08:00 Belgium time (UTC+1)
  const hour = new Date().getUTCHours() + 1;
  if (hour >= 23 || hour < 8) {
    log('[main] Night mode — skipping replies until 08:00');
    return;
  }

  log(`[main] Processing conversation ${conv.conversationId} with ${conv.senderName}`);

  // Skip conversations where the last message was sent by us.
  // Compare against currentUserId fetched at startup from /api/v2/users/current —
  // this is the authoritative check; the opposite_user heuristic was unreliable.
  if (currentUserId !== null && conv.lastSenderId !== null &&
      String(conv.lastSenderId) === String(currentUserId)) {
    log(`[main] Last message in ${conv.conversationId} is ours (userId=${currentUserId}) — skipping.`);
    markHandled(conv.conversationId, conv.lastMessage);
    return;
  }

  // Deduplicate: skip if we already handled this exact last message
  if (isHandled(conv.conversationId, conv.lastMessage)) {
    log(`[main] Already handled conversation ${conv.conversationId} ("${conv.lastMessage.slice(0, 60)}") — skipping.`);
    return;
  }

  const { senderName, itemTitle, messages } = await readConversation(conv.conversationUrl);

  // Find the latest buyer message
  const buyerMessages = messages.filter((m) => m.author === 'buyer');
  if (buyerMessages.length === 0) {
    log(`[main] No buyer messages found in conversation ${conv.conversationId} — skipping.`);
    return;
  }
  const latestMessage = buyerMessages[buyerMessages.length - 1].text;

  // DOM-level safety net: confirm the last scraped message isn't ours
  if (messages[messages.length - 1]?.author === 'me') {
    log(`[main] Last DOM message is ours — skipping conversation ${conv.conversationId}.`);
    markHandled(conv.conversationId, conv.lastMessage);
    return;
  }

  log(`[main] Buyer says: "${latestMessage.slice(0, 100)}"`);

  // SOP matching: API item title is most reliable; fall back to DOM title
  // then to the last message text as a last resort.
  const effectiveTitle  = conv.itemTitle || itemTitle || conv.lastMessage || '';
  const effectiveSender = senderName || conv.senderName  || '';
  log(`[main] effectiveTitle="${effectiveTitle.slice(0, 80)}", effectiveSender="${effectiveSender}"`);

  const sop = matchSop(effectiveTitle);
  if (!sop) {
    log(`[main] No SOP found for item "${effectiveTitle}" — skipping.`);
    return;
  }

  // Get Claude's reply
  const reply = await getClaudeReply(sop, messages, latestMessage);
  if (!reply) {
    log(`[main] Claude returned an empty reply — skipping.`);
    return;
  }

  // Accept offer if one is pending and the offered price meets the SOP minimum.
  // This runs before sending the reply so the acceptance is registered first.
  try {
    const offer = await acceptOffer(conv.conversationId, sop.price_minimum);
    if (offer.offerPrice !== null) {
      if (offer.accepted) {
        log(`[main] Offer of €${offer.offerPrice} accepted for conversation ${conv.conversationId}.`);
      } else {
        log(`[main] Offer of €${offer.offerPrice} is below minimum €${sop.price_minimum} — not accepting.`);
      }
    }
  } catch (err) {
    log(`[main] acceptOffer error (non-fatal): ${err.message}`);
  }

  // Mark as handled BEFORE sending so a crash or slow API update
  // on the next poll never triggers a second reply to the same message.
  markHandled(conv.conversationId, conv.lastMessage);

  // Human-like pause before typing
  await randomDelay(1500, 3000);

  // Send the reply
  await sendReply(reply);

  // Also mark the bot's own reply text as handled. If the API is slow
  // to update, the next poll may return our reply as conv.lastMessage;
  // this second key prevents re-processing it.
  markHandled(conv.conversationId, reply);
  log(`[main] Done with conversation ${conv.conversationId}.`);
}

async function poll() {
  log('[main] Polling inbox…');

  try {
    const conversations = await getUnreadConversations();
    log(`[main] Found ${conversations.length} conversation(s).`);

    for (const conv of conversations) {
      try {
        // Human-like delay before each conversation (20–45 seconds)
        const delay = Math.floor(Math.random() * 25000) + 20000;
        log(`[main] Waiting ${Math.round(delay / 1000)}s before next conversation…`);
        await new Promise((resolve) => setTimeout(resolve, delay));

        await processConversation(conv);
        // Small pause between conversations — never act on two at once
        await randomDelay(2000, 4000);
      } catch (err) {
        log(`[main] Error in conversation ${conv.conversationId}: ${err.message}`);
      }
    }
  } catch (err) {
    if (err.message?.includes('SESSION_EXPIRED') || err.message?.includes('net::ERR')) {
      throw err; // Bubble up session errors to the main loop
    }
    log(`[main] Inbox polling error: ${err.message}`);
  }
}

async function main() {
  log('[main] Vinted bot starting…');

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_api_key_here') {
    console.error('[main] ERROR: ANTHROPIC_API_KEY is not set in .env');
    process.exit(1);
  }

  try {
    log('[main] Loading browser session…');
    try {
      await loadSession();
    } catch (err) {
      log(`[main] FATAL: ${err.message}`);
      process.exit(1);
    }

    log('[main] Session loaded. Fetching current user id…');
    currentUserId = await getCurrentUserId();
    log(`[main] Bot identity: userId=${currentUserId ?? 'unknown'}`);
    if (!currentUserId) {
      log('[main] WARNING: Could not resolve current user id — bot-reply detection will rely on fallbacks only.');
    }

    log('[main] Entering polling loop…');

    // Refresh the Vinted session token every 90 minutes so the bot never
    // gets kicked out mid-run due to an expired access token.
    const NINETY_MIN_MS = 90 * 60 * 1000;
    setInterval(async () => {
      log('[main] Scheduled token refresh…');
      await refreshSession();
    }, NINETY_MIN_MS);

    const MAX_SESSION_RETRIES = 3;
    const SESSION_RETRY_WAIT_MS = 5 * 60 * 1000; // 5 minutes
    let sessionRetries = 0;

    while (true) {
      try {
        await poll();
        sessionRetries = 0; // reset on a clean poll
      } catch (err) {
        if (err.message?.includes('SESSION_EXPIRED') || err.message?.includes('net::ERR')) {
          sessionRetries++;
          if (sessionRetries >= MAX_SESSION_RETRIES) {
            log(`[main] Session error ${sessionRetries}/${MAX_SESSION_RETRIES} times in a row — giving up. Re-run  node browser.js --save-session  then restart.`);
            await closeBrowser();
            process.exit(1);
          }
          log(`[main] Session error (attempt ${sessionRetries}/${MAX_SESSION_RETRIES}): ${err.message} — waiting 5 min before retry…`);
          await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_WAIT_MS));
          continue; // skip the normal inter-poll wait
        }
        log(`[main] Unexpected poll error: ${err.message}`);
      }

      const wait = nextPollInterval();
      log(`[main] Next poll in ${Math.round(wait / 1000)}s.`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  } catch (err) {
    log(`[main] Fatal uncaught error: ${err.message}\n${err.stack}`);
    process.exit(1);
  }
}

main();
