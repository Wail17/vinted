// utils.js — shared helpers

import fs from 'fs';
import { config } from './config.js';

/**
 * Sleep for a random duration between min and max milliseconds.
 * Defaults to config.actionDelayMin / actionDelayMax.
 */
export function randomDelay(
  min = config.actionDelayMin,
  max = config.actionDelayMax
) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Random polling interval between pollIntervalMin and pollIntervalMax.
 */
export function nextPollInterval() {
  return (
    Math.floor(
      Math.random() * (config.pollIntervalMax - config.pollIntervalMin + 1)
    ) + config.pollIntervalMin
  );
}

/**
 * Append a timestamped entry to the log file and also print to stdout.
 */
export function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(config.logFile, line + '\n');
}

// ─── Handled-conversations persistence ──────────────────────────────────────

let handled = null;

function loadHandled() {
  if (handled !== null) return;
  if (fs.existsSync(config.handledFile)) {
    handled = new Set(JSON.parse(fs.readFileSync(config.handledFile, 'utf8')));
  } else {
    handled = new Set();
  }
}

function saveHandled() {
  fs.writeFileSync(config.handledFile, JSON.stringify([...handled]), 'utf8');
}

/**
 * Returns true if we have already replied to this conversation+messageCount combo.
 * Using conversationId + message count as a key prevents double-replies.
 */
export function isHandled(conversationId, messageCount) {
  loadHandled();
  return handled.has(`${conversationId}:${messageCount}`);
}

/**
 * Mark a conversation+messageCount as handled so we never reply twice.
 */
export function markHandled(conversationId, messageCount) {
  loadHandled();
  handled.add(`${conversationId}:${messageCount}`);
  saveHandled();
}
