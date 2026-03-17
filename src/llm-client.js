import OpenAI from 'openai';
import { config } from './config.js';
import { logger } from './logger.js';

const MOD = 'llm';

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return client;
}

/** Per-channel conversation history */
const histories = new Map();

function getHistory(channelId) {
  if (!histories.has(channelId)) {
    histories.set(channelId, []);
  }
  return histories.get(channelId);
}

export function clearHistory(channelId) {
  histories.delete(channelId);
  logger.info(MOD, `Cleared history for channel ${channelId}`);
}

const SYSTEM_PROMPT = `You are Lodekeeper, an AI assistant participating in a Discord voice channel conversation. You are an AI contributor to Lodestar, the TypeScript Ethereum consensus client.

Rules:
- Keep responses brief and conversational — 1-3 sentences unless asked for detail.
- Your responses will be spoken aloud via text-to-speech, so do NOT use markdown, bullet points, code blocks, or special formatting.
- Be direct, helpful, and natural. Speak as if you're in a real conversation.
- Multiple people may be in the channel. Their messages are prefixed with [Name]: — address them by name when helpful.
- If a message seems garbled or nonsensical, just ask them to repeat rather than guessing.
- You can discuss Ethereum, Lodestar, TypeScript, and general topics.`;

/**
 * Send a message to the LLM and get a response.
 * @param {string} channelId
 * @param {string} userId - Discord user ID (for tracking, not sent to LLM)
 * @param {string} userName - Display name of speaker
 * @param {string} transcript - What the user said (STT output)
 * @returns {Promise<string>}
 */
export async function chat(channelId, userId, userName, transcript) {
  const history = getHistory(channelId);

  // Format: [Speaker Name]: what they said
  const content = userName ? `[${userName}]: ${transcript}` : transcript;
  history.push({ role: 'user', content });

  // Trim to max history
  while (history.length > 20) {
    history.shift();
  }

  logger.debug(MOD, `Chat request (${history.length} msgs): "${transcript}"`);

  try {
    const response = await getClient().chat.completions.create({
      model: 'gpt-4.1-mini',
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
      ],
    });

    const text = response.choices[0]?.message?.content?.trim() || '';
    history.push({ role: 'assistant', content: text });
    logger.info(MOD, `Response (${text.length} chars): "${text.substring(0, 100)}..."`);
    return text;
  } catch (err) {
    logger.error(MOD, `LLM error: ${err.message}`);
    history.pop(); // remove failed user message
    throw err;
  }
}
