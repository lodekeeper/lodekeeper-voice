import pkg from '@discordjs/opus';
const { OpusEncoder } = pkg;
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { logger } from './logger.js';

const MOD = 'receiver';

// Discord Opus: 48kHz stereo
const OPUS_RATE = 48000;
const OPUS_CHANNELS = 2;
const OPUS_FRAME_SIZE = 960; // 20ms at 48kHz

// Target for STT: 16kHz mono
const TARGET_RATE = 16000;

const encoder = new OpusEncoder(OPUS_RATE, OPUS_CHANNELS);

/**
 * Manages audio reception for a single user.
 * Decodes Opus → PCM, downsamples, runs VAD, emits 'turn-complete' with the buffered audio.
 */
export class UserAudioReceiver extends EventEmitter {
  /**
   * @param {string} userId - Discord user ID
   */
  constructor(userId) {
    super();
    this.userId = userId;
    this.pcmChunks = [];
    this.isSpeaking = false;
    this.silenceStart = null;
    this.totalSamples = 0;
  }

  /**
   * Feed an Opus packet from the Discord receive stream.
   * @param {Buffer} opusPacket
   */
  processPacket(opusPacket) {
    let pcm;
    try {
      pcm = encoder.decode(opusPacket);
    } catch (err) {
      logger.debug(MOD, `Opus decode error for ${this.userId}`, err.message);
      return;
    }

    // Downsample: 48kHz stereo → 16kHz mono
    const mono16k = downsample(pcm, OPUS_RATE, OPUS_CHANNELS, TARGET_RATE);

    // RMS-based VAD
    const rms = computeRms(mono16k);
    const threshold = config.voice.speechThreshold;

    if (rms >= threshold) {
      // Speech detected
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.pcmChunks = [];
        this.totalSamples = 0;
        logger.debug(MOD, `Speech start: user ${this.userId}`);
      }
      this.silenceStart = null;
      this.pcmChunks.push(mono16k);
      this.totalSamples += mono16k.length / 2; // 16-bit = 2 bytes per sample
    } else if (this.isSpeaking) {
      // Silence during speech — buffer it (might be a pause)
      this.pcmChunks.push(mono16k);
      this.totalSamples += mono16k.length / 2;

      if (!this.silenceStart) {
        this.silenceStart = Date.now();
      } else if (Date.now() - this.silenceStart >= config.voice.silenceDurationMs) {
        // Turn complete
        this.finishTurn();
      }
    }
    // If not speaking and below threshold, discard (silence before speech)
  }

  /**
   * Handle the Discord speaking-end event (user stopped transmitting).
   */
  onSpeakingEnd() {
    if (this.isSpeaking && this.pcmChunks.length > 0) {
      this.finishTurn();
    }
  }

  /**
   * Flush any buffered audio as a complete turn.
   */
  finishTurn() {
    if (this.pcmChunks.length === 0) return;

    const fullBuffer = Buffer.concat(this.pcmChunks);
    const durationSec = this.totalSamples / TARGET_RATE;
    logger.info(MOD, `Turn complete: user ${this.userId}, ${durationSec.toFixed(1)}s, ${fullBuffer.length} bytes`);

    this.emit('turn-complete', {
      userId: this.userId,
      pcmBuffer: fullBuffer,
      durationSec,
    });

    this.pcmChunks = [];
    this.totalSamples = 0;
    this.isSpeaking = false;
    this.silenceStart = null;
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this.pcmChunks = [];
    this.removeAllListeners();
  }
}

/**
 * Downsample stereo PCM at sourceRate to mono PCM at targetRate.
 * Simple linear interpolation + channel averaging.
 * Input: 16-bit LE signed PCM
 */
function downsample(pcmBuffer, sourceRate, sourceChannels, targetRate) {
  const bytesPerSample = 2; // 16-bit
  const sourceFrameSize = sourceChannels * bytesPerSample;
  const numSourceFrames = pcmBuffer.length / sourceFrameSize;
  const ratio = sourceRate / targetRate;
  const numTargetFrames = Math.floor(numSourceFrames / ratio);

  const output = Buffer.alloc(numTargetFrames * bytesPerSample);

  for (let i = 0; i < numTargetFrames; i++) {
    const srcIdx = Math.floor(i * ratio);
    // Average channels to mono
    let sum = 0;
    for (let ch = 0; ch < sourceChannels; ch++) {
      sum += pcmBuffer.readInt16LE((srcIdx * sourceChannels + ch) * bytesPerSample);
    }
    const mono = Math.round(sum / sourceChannels);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * bytesPerSample);
  }

  return output;
}

/**
 * Compute RMS energy of a 16-bit LE mono PCM buffer (normalized 0-1).
 */
function computeRms(pcmBuffer) {
  const numSamples = pcmBuffer.length / 2;
  if (numSamples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < numSamples; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / numSamples);
}
