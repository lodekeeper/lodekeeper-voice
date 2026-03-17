import OpenAI from 'openai';
import { config } from './config.js';
import { logger } from './logger.js';

const MOD = 'tts';

const client = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Convert text to speech audio.
 * Returns an OGG/Opus buffer that @discordjs/voice can play directly.
 * @param {string} text - Text to speak
 * @returns {Promise<Buffer>} Audio buffer (OGG Opus)
 */
export async function synthesize(text) {
  if (!text.trim()) return null;

  try {
    const response = await client.audio.speech.create({
      model: config.tts.model,
      voice: config.tts.voice,
      input: text,
      response_format: 'opus', // OGG/Opus container — discord.js plays this natively
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    logger.debug(MOD, `TTS generated ${buffer.length} bytes for "${text.slice(0, 50)}..."`);
    return buffer;
  } catch (err) {
    logger.error(MOD, 'TTS synthesis failed', err.message);
    return null;
  }
}
