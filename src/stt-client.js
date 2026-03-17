import { DeepgramClient } from '@deepgram/sdk';
import OpenAI, { toFile } from 'openai';
import { config } from './config.js';
import { logger } from './logger.js';

const MOD = 'stt';

let deepgram = null;
let openai = null;

if (config.deepgram.apiKey) {
  deepgram = new DeepgramClient({ apiKey: config.deepgram.apiKey });
  logger.info(MOD, 'Deepgram STT initialized (Nova-3)');
} else if (config.openai.apiKey) {
  openai = new OpenAI({ apiKey: config.openai.apiKey });
  logger.info(MOD, 'Using OpenAI Whisper STT fallback (no Deepgram key)');
} else {
  logger.warn(MOD, 'No STT provider configured — set DEEPGRAM_API_KEY or OPENAI_API_KEY');
}

/**
 * Transcribe a PCM audio buffer (16kHz, 16-bit LE, mono) to text.
 * @param {Buffer} pcmBuffer - Raw PCM audio
 * @returns {Promise<string>} transcript text
 */
export async function transcribe(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 1600) {
    return ''; // too short to be speech
  }

  // Wrap raw PCM in a minimal WAV header for API consumption
  const wavBuffer = wrapPcmAsWav(pcmBuffer, 16000, 1, 16);

  if (deepgram) {
    return transcribeDeepgram(wavBuffer);
  } else if (openai) {
    return transcribeWhisper(wavBuffer);
  }
  logger.error(MOD, 'No STT provider available');
  return '';
}

async function transcribeDeepgram(wavBuffer) {
  try {
    const response = await deepgram.listen.prerecorded.transcribeFile(wavBuffer, {
      model: 'nova-3',
      language: 'en',
      smart_format: true,
    });
    const transcript = response?.result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    logger.debug(MOD, `Deepgram transcript: "${transcript}"`);
    return transcript.trim();
  } catch (err) {
    logger.error(MOD, 'Deepgram transcription failed', err.message);
    return '';
  }
}

async function transcribeWhisper(wavBuffer) {
  try {
    const file = await toFile(wavBuffer, 'audio.wav', { type: 'audio/wav' });
    const result = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'en',
    });
    const transcript = result.text || '';
    logger.debug(MOD, `Whisper transcript: "${transcript}"`);
    return transcript.trim();
  } catch (err) {
    logger.error(MOD, 'Whisper transcription failed', err.message);
    return '';
  }
}

/**
 * Wrap raw PCM data in a WAV container.
 */
function wrapPcmAsWav(pcm, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
