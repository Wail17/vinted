# Vinted Bot — Claude Code Context

## Project
Vinted seller bot — Node.js + Playwright + Claude API

## Infrastructure
- **VPS:** root@46.224.113.203
- **Stack:** Node.js ESM, Playwright, PM2, IPRoyal residential proxy (Belgium)
- **Repo:** github.com/Wail17/vinted, branch: `claude/vinted-automation-bot-jVrWl`

## Key Files
| File | Purpose |
|---|---|
| `browser.js` | Playwright session, proxy config, session refresh |
| `messageHandler.js` | Inbox polling, offer detection, `acceptOffer()` |
| `main.js` | Polling loop, `handled.json` dedup |
| `session.json` | Vinted cookies (manual refresh needed every 7 days) |
| `handled.json` | Array of processed conversation keys |
| `.env` | `PROXY_USERNAME`, `PROXY_PASSWORD`, `ANTHROPIC_API_KEY` |

## Commands
```bash
# Start / restart / stop
pm2 start ecosystem.config.cjs
pm2 restart vinted-bot
pm2 stop vinted-bot

# Logs
pm2 logs vinted-bot --lines 50

# Deploy latest changes
git pull && pm2 restart vinted-bot
```

## Autonomy Rules
- Never ask clarifying questions — make decisions and execute
- Always `git pull` before making changes
- Always check `pm2 logs` after restart to confirm no errors
- Commit all changes with clear, descriptive messages
- If errors appear in logs, diagnose and fix before reporting done

## Current SOP
- **Item:** Asics Kayano 14
- **Listed price:** 45 €
- **Minimum acceptable price:** 38 €

## Session Management
Session cookies expire every ~7 days — must be refreshed manually by the user.
Run `node browser.js --save-session` on the VPS to re-authenticate.
