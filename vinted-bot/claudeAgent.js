// claudeAgent.js — call the Claude API with a SOP as system prompt

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { log } from './utils.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cache loaded SOPs in memory
const sopCache = new Map();

/**
 * Load a SOP JSON file by filename (without extension).
 * Falls back to a generic SOP if no match is found.
 */
function loadSop(sopName) {
  if (sopCache.has(sopName)) return sopCache.get(sopName);

  const sopPath = path.resolve(config.sopDir, `${sopName}.json`);
  if (!fs.existsSync(sopPath)) {
    log(`[claudeAgent] WARNING: SOP "${sopName}" not found, using default.`);
    return null;
  }

  const sop = JSON.parse(fs.readFileSync(sopPath, 'utf8'));
  sopCache.set(sopName, sop);
  return sop;
}

/**
 * Pick the best matching SOP based on the item title from the conversation.
 * Returns the SOP object or null.
 */
export function matchSop(itemTitle) {
  const sopFiles = fs.readdirSync(path.resolve(config.sopDir)).filter((f) => f.endsWith('.json'));

  for (const file of sopFiles) {
    const sopName = file.replace('.json', '');
    const sop = loadSop(sopName);
    if (!sop) continue;

    // Simple keyword match between the item title and the SOP item name
    const keywords = sop.item.toLowerCase().split(/\s+/);
    const titleLower = itemTitle.toLowerCase();
    const matched = keywords.filter((kw) => kw.length > 3 && titleLower.includes(kw));
    if (matched.length >= 2) return sop;
  }

  // Fallback: return first available SOP
  const firstFile = sopFiles[0];
  return firstFile ? loadSop(firstFile.replace('.json', '')) : null;
}

/**
 * Build the system prompt by injecting the SOP JSON.
 */
function buildSystemPrompt(sop) {
  const sopJson = JSON.stringify(sop, null, 2);
  return `Tu es moi. Tu réponds à mes messages Vinted à ma place. Voici mes règles pour cet article :

${sopJson}

Règles absolues :
- Réponds de manière naturelle, courte (1-3 phrases max), en français familier.
- Ne jamais mentionner que tu es un bot ou une IA.
- Ne jamais descendre sous ${sop.price_minimum}€.
- Ne jamais mentionner l'info sensible (${sop.sensitive_info}) sauf si la personne pose la question directement dans son message.
- Si quelqu'un demande un prix, rappelle le prix négocié (${sop.price_negotiated}€).
- Sois direct, pas de blabla inutile.`;
}

/**
 * Call the Claude API and return the reply text.
 * @param {Object} sop - The SOP object for this item
 * @param {Array}  messages - Conversation history [{author, text}]
 * @param {string} latestMessage - The buyer's latest message
 */
export async function getClaudeReply(sop, messages, latestMessage) {
  const systemPrompt = buildSystemPrompt(sop);

  // Build conversation history for context (last 6 messages max to keep tokens low)
  const recentHistory = messages.slice(-6);
  const historyText = recentHistory
    .map((m) => `${m.author === 'me' ? 'Moi' : 'Acheteur'}: ${m.text}`)
    .join('\n');

  const userMessage = historyText
    ? `Historique de la conversation :\n${historyText}\n\nDernier message de l'acheteur : "${latestMessage}"`
    : `Message de l'acheteur : "${latestMessage}"`;

  log(`[claudeAgent] Calling Claude (${config.claudeModel})…`);

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: config.maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const reply = response.content[0]?.text?.trim() || '';
  log(`[claudeAgent] Claude replied: "${reply.slice(0, 120)}"`);
  return reply;
}
