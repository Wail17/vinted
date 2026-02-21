// main.js — orchestrator: polling loop that ties everything together

import 'dotenv/config';
import { loadSession, isSessionValid, closeBrowser } from './browser.js';
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

  // Match SOP to item
  const sop = matchSop(itemTitle || conv.itemTitle);
  if (!sop) {
    log(`[main] No SOP found for item "${itemTitle}" — skipping.`);
    return;
  }

  // Get Claude's reply
  const reply = await getClaudeReply(sop, messages, latestMessage);
  if (!reply) {
    log(`[main] Claude returned an empty reply — skipping.`);
    return;
  }

  // Human-like pause before typing
  await randomDelay(1500, 3000);

  // Send the reply
  await sendReply(reply);

  // Mark as handled
  markHandled(conv.conversationId, conv.lastMessage);
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
