// main.js — orchestrator: polling loop that ties everything together

import 'dotenv/config';
import { loadSession, isSessionValid, closeBrowser, refreshSession } from './browser.js';
import { getUnreadConversations, readConversation, sendReply } from './messageHandler.js';
import { matchSop, getClaudeReply } from './claudeAgent.js';
import { randomDelay, nextPollInterval, log, isHandled, markHandled } from './utils.js';

async function processConversation(conv) {
  log(`[main] Processing conversation ${conv.conversationId} with ${conv.senderName}`);

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

  // Make sure the last message is not ours (avoid replying to ourselves)
  if (messages[messages.length - 1]?.author === 'me') {
    log(`[main] Last message is ours — skipping conversation ${conv.conversationId}.`);
    markHandled(conv.conversationId, conv.lastMessage);
    return;
  }

  log(`[main] Buyer says: "${latestMessage.slice(0, 100)}"`);

  // Match SOP to item — fall back to API last message if DOM title is empty
  const effectiveTitle  = itemTitle  || conv.lastMessage || '';
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

  log('[main] Loading browser session…');
  let page;
  try {
    page = await loadSession();
  } catch (err) {
    log(`[main] FATAL: ${err.message}`);
    process.exit(1);
  }

  // Verify session is still alive
  const valid = await isSessionValid();
  if (!valid) {
    log('[main] FATAL: Session appears to be expired. Run  node browser.js --save-session  to refresh.');
    await closeBrowser();
    process.exit(1);
  }

  log('[main] Session OK. Entering polling loop…');

  // Refresh the Vinted session token every 6 hours so the bot never
  // gets kicked out mid-run due to an expired access token.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    log('[main] Scheduled token refresh…');
    await refreshSession();
  }, SIX_HOURS_MS);

  while (true) {
    try {
      await poll();
    } catch (err) {
      if (err.message?.includes('SESSION_EXPIRED')) {
        log('[main] Session expired during poll. Stopping. Re-run  node browser.js --save-session  then restart.');
        await closeBrowser();
        process.exit(1);
      }
      log(`[main] Unexpected error: ${err.message}`);
    }

    const wait = nextPollInterval();
    log(`[main] Next poll in ${Math.round(wait / 1000)}s.`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

main();
