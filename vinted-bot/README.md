# Vinted Bot

Automated Vinted inbox responder using Playwright + Claude AI.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install the Chromium browser for Playwright
npx playwright install chromium

# 3. Copy the env file and add your API key
cp .env .env.local  # or just edit .env directly
# → Set ANTHROPIC_API_KEY to your key from https://console.anthropic.com

# 4. Log in manually and save the session
node browser.js --save-session
# → A browser window opens. Log in to vinted.fr, then press ENTER in the terminal.
# → This saves session.json (cookies). Never commit this file.

# 5. Start the bot
npm start
```

## Files

| File | Purpose |
|------|---------|
| `main.js` | Orchestrator — polling loop |
| `browser.js` | Playwright session management |
| `messageHandler.js` | Read inbox & send replies |
| `claudeAgent.js` | Claude API calls with SOP injection |
| `utils.js` | Shared helpers (delays, logging, handled-tracking) |
| `config.js` | Intervals, model, paths |
| `sops/` | One JSON file per item for sale |
| `.env` | `ANTHROPIC_API_KEY` |

## Adding a new item

Create `sops/your-item-name.json` following the same schema as `asics-running.json`.
The bot auto-matches conversations to SOPs by keyword matching the item title.

## Logs

- `messages.log` — all activity timestamped
- `handled.json` — tracks replied conversations to avoid double-replies

## Session expiry

If the bot stops with a SESSION_EXPIRED error, re-run:
```bash
node browser.js --save-session
npm start
```
