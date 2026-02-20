// config.js — central configuration

export const config = {
  // Polling interval range (milliseconds)
  pollIntervalMin: 3 * 60 * 1000,  // 3 minutes
  pollIntervalMax: 5 * 60 * 1000,  // 5 minutes

  // Human-like delay range between individual actions (milliseconds)
  actionDelayMin: 1000,
  actionDelayMax: 3000,

  // Claude model to use
  claudeModel: 'claude-opus-4-5',

  // Max tokens for Claude responses (Vinted messages are short)
  maxTokens: 300,

  // Vinted URLs
  vintedBaseUrl: 'https://www.vinted.fr',
  vintedInboxUrl: 'https://www.vinted.fr/inbox',

  // File paths
  sessionFile: process.env.SESSION_FILE || './session.json',
  handledFile: './handled.json',
  logFile: './messages.log',

  // SOP directory
  sopDir: './sops',
};
