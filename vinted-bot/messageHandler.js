// messageHandler.js — read unread conversations and send replies via Playwright

import { getPage } from './browser.js';
import { config } from './config.js';
import { randomDelay, log } from './utils.js';

/**
 * Navigate to the Vinted inbox and return a list of unread conversation entries.
 * Each entry: { conversationUrl, senderName, itemTitle, conversationId }
 */
export async function getUnreadConversations() {
  const page = getPage();
  await page.goto(config.vintedInboxUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await randomDelay();

  // Collect all conversation rows in the inbox
  const conversations = await page.$$eval(
    '[data-testid="inbox-item"], .inbox__item, a[href*="/conversation/"]',
    (els) =>
      els.map((el) => {
        const link = el.href || el.querySelector('a')?.href || '';
        const idMatch = link.match(/\/conversation\/(\d+)/);
        return {
          conversationUrl: link,
          conversationId: idMatch ? idMatch[1] : null,
          // Try to extract sender / item name from visible text
          senderName: el.querySelector('[class*="sender"], [class*="user"], strong')?.textContent?.trim() || '',
          itemTitle: el.querySelector('[class*="item"], [class*="title"]')?.textContent?.trim() || '',
          hasUnread: el.classList.contains('is-unread') || el.querySelector('[class*="unread"]') !== null,
        };
      })
  );

  return conversations.filter((c) => c.conversationId && c.hasUnread);
}

/**
 * Open a conversation URL and extract the full message thread.
 * Returns: { senderName, itemTitle, messages: [{author, text}] }
 */
export async function readConversation(conversationUrl) {
  const page = getPage();
  await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await randomDelay();

  // Extract item title from the conversation header
  const itemTitle = await page
    .$eval('[data-testid="item-title"], [class*="item-title"], [class*="ItemTitle"]', (el) => el.textContent.trim())
    .catch(() => '');

  // Extract sender name from the conversation header
  const senderName = await page
    .$eval('[data-testid="conversation-user"], [class*="conversation__user"], [class*="Username"]', (el) =>
      el.textContent.trim()
    )
    .catch(() => '');

  // Extract all messages in the thread
  const messages = await page.$$eval(
    '[data-testid="message-bubble"], [class*="message__bubble"], [class*="MessageBubble"]',
    (bubbles) =>
      bubbles.map((b) => ({
        // Vinted marks own messages differently
        author: b.classList.contains('is-own') || b.closest('[class*="own"]') ? 'me' : 'buyer',
        text: b.textContent.trim(),
      }))
  );

  return { senderName, itemTitle, messages };
}

/**
 * Type and send a reply in the currently open conversation.
 * Includes human-like delays between focus, typing, and submit.
 */
export async function sendReply(replyText) {
  const page = getPage();

  // Locate the message input (textarea or contenteditable div)
  const inputSelector =
    'textarea[data-testid="message-input"], textarea[placeholder], [contenteditable="true"][data-testid*="input"], [contenteditable="true"][class*="input"]';

  const input = await page.$(inputSelector);
  if (!input) {
    throw new Error('Could not find the message input field.');
  }

  await input.click();
  await randomDelay(500, 1200);

  // Type character by character with slight variance to mimic human typing
  for (const char of replyText) {
    await input.type(char, { delay: Math.floor(Math.random() * 60) + 30 });
  }

  await randomDelay(800, 2000);

  // Submit via Enter key or the send button
  const sendButton = await page.$('[data-testid="send-button"], button[type="submit"][class*="send"]');
  if (sendButton) {
    await sendButton.click();
  } else {
    await input.press('Enter');
  }

  await randomDelay();
  log(`[messageHandler] Reply sent: "${replyText.slice(0, 80)}…"`);
}
