import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { logger } from './logger.js';

const MOD = 'llm';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Per-channel conversation history: Map<channelId, {role, content}[]>
const histories = new Map();

/**
 * Get a response from Claude for a user's spoken message.
 * @param {string} channelId - Voice channel ID
 * @param {string} userId - Discord user ID
 * @param {string} username - Display name
 * @param {string} text - Transcribed speech
 * @returns {Promise<string>} Claude's response text
 */
export async function chat(channelId, userId, username, text) {
  if (!text.trim()) return '';

  let history = histories.get(channelId);
  if (!history) {
    history = [];
    histories.set(channelId, history);
  }

  // Add user message with speaker attribution
  history.push({ role: 'user', content: `[${username}]: ${text}` });

  // Trim to max history
  while (history.length > config.llm.maxHistory) {
    history.shift();
  }

  try {
    const response = await client.messages.create({
      model: config.llm.model,
      max_tokens: config.llm.maxTokens,
      system: config.llm.systemPrompt,
      messages: history,
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Add assistant response to history
    history.push({ role: 'assistant', content: reply });

    logger.debug(MOD, `Claude reply (${reply.length} chars) for channel ${channelId}`);
    return reply;
  } catch (err) {
    logger.error(MOD, 'Claude API error', err.message);
    return "Sorry, I couldn't process that. Try again.";
  }
}

/**
 * Clear conversation history for a channel.
 */
export function clearHistory(channelId) {
  histories.delete(channelId);
  logger.info(MOD, `Cleared history for channel ${channelId}`);
}
