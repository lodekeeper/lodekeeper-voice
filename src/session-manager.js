import { VoicePlayer } from './audio-player.js';
import { UserAudioReceiver } from './audio-receiver.js';
import { transcribe } from './stt-client.js';
import { chat, clearHistory } from './llm-client.js';
import { synthesize } from './tts-client.js';
import { config } from './config.js';
import { logger } from './logger.js';

const MOD = 'session';

/**
 * State machine for a voice channel session.
 * States: idle | listening | processing | speaking
 */
export class VoiceSession {
  /**
   * @param {string} channelId
   * @param {string} guildId
   * @param {import('@discordjs/voice').VoiceConnection} connection
   * @param {import('discord.js').Client} discordClient
   */
  constructor(channelId, guildId, connection, discordClient) {
    this.channelId = channelId;
    this.guildId = guildId;
    this.connection = connection;
    this.discordClient = discordClient;
    this.audioPlayer = new VoiceAudioPlayer();
    this.receivers = new Map(); // userId → UserAudioReceiver
    this.state = 'idle';
    this.lastActivity = Date.now();
    this.createdAt = Date.now();
    this.processingQueue = []; // queue turns during processing/speaking

    // Subscribe the audio player to the connection
    connection.subscribe(this.audioPlayer.rawPlayer);

    // Set up speaking listeners
    this._setupSpeakingListeners();

    // Idle timeout
    this._idleTimer = setInterval(() => this._checkIdle(), 30_000);

    // Hard session cap
    this._hardTimer = setTimeout(() => {
      logger.info(MOD, `Hard session cap (${config.voice.maxSessionMinutes}min) reached for ${channelId}`);
      this.destroy('Session time limit reached. Leaving voice channel.');
    }, config.voice.maxSessionMinutes * 60 * 1000);

    logger.info(MOD, `Voice session started: channel=${channelId} guild=${guildId}`);
  }

  _setupSpeakingListeners() {
    const receiver = this.connection.receiver;

    receiver.speaking.on('start', (userId) => {
      this.lastActivity = Date.now();

      if (!this.receivers.has(userId)) {
        const userReceiver = new UserAudioReceiver(userId);
        this.receivers.set(userId, userReceiver);

        userReceiver.on('turn-complete', (turnData) => {
          this._handleTurnComplete(turnData);
        });
      }

      // Subscribe to this user's audio stream
      const audioStream = receiver.subscribe(userId, { end: { behavior: 'manual' } });
      const userReceiver = this.receivers.get(userId);

      // Pipe Opus packets to receiver
      audioStream.on('data', (chunk) => {
        userReceiver.processPacket(chunk);
      });
    });

    receiver.speaking.on('end', (userId) => {
      const userReceiver = this.receivers.get(userId);
      if (userReceiver) {
        userReceiver.onSpeakingEnd();
      }
    });
  }

  async _handleTurnComplete({ userId, pcmBuffer, durationSec }) {
    // If we're already processing or speaking, queue this turn
    if (this.state === 'processing' || this.state === 'speaking') {
      logger.info(MOD, `Queuing turn from ${userId} (current state: ${this.state})`);
      this.processingQueue.push({ userId, pcmBuffer, durationSec });
      return;
    }

    await this._processTurn(userId, pcmBuffer, durationSec);
  }

  async _processTurn(userId, pcmBuffer, durationSec) {
    this.state = 'processing';
    this.lastActivity = Date.now();

    try {
      // Resolve username
      let username = `User-${userId.slice(-4)}`;
      try {
        const user = await this.discordClient.users.fetch(userId);
        username = user.displayName || user.username;
      } catch { /* use fallback */ }

      // 1. STT
      logger.info(MOD, `Processing ${durationSec.toFixed(1)}s audio from ${username}`);
      const transcript = await transcribe(pcmBuffer);

      if (!transcript) {
        logger.info(MOD, `Empty transcript from ${username}, skipping`);
        this.state = 'idle';
        this._processNextQueued();
        return;
      }

      logger.info(MOD, `[${username}]: "${transcript}"`);

      // 2. LLM
      const reply = await chat(this.channelId, userId, username, transcript);

      if (!reply) {
        this.state = 'idle';
        this._processNextQueued();
        return;
      }

      logger.info(MOD, `[Lodekeeper]: "${reply}"`);

      // 3. TTS
      const audioBuffer = await synthesize(reply);

      if (!audioBuffer) {
        this.state = 'idle';
        this._processNextQueued();
        return;
      }

      // 4. Play audio
      this.state = 'speaking';
      this.audioPlayer.play(audioBuffer);

      // Wait for playback to finish
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.audioPlayer.isPlaying) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
        // Safety timeout: 30s max playback
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 30_000);
      });

      this.state = 'idle';
      this._processNextQueued();
    } catch (err) {
      logger.error(MOD, 'Turn processing error', err.message);
      this.state = 'idle';
      this._processNextQueued();
    }
  }

  _processNextQueued() {
    if (this.processingQueue.length > 0) {
      const next = this.processingQueue.shift();
      this._processTurn(next.userId, next.pcmBuffer, next.durationSec);
    }
  }

  _checkIdle() {
    const idleMs = Date.now() - this.lastActivity;
    const maxIdleMs = config.voice.idleTimeoutMinutes * 60 * 1000;
    if (idleMs > maxIdleMs) {
      logger.info(MOD, `Idle timeout (${config.voice.idleTimeoutMinutes}min) for ${this.channelId}`);
      this.destroy('Idle timeout — leaving voice channel.');
    }
  }

  /**
   * Clean up and leave the voice channel.
   * @param {string} [reason] - Optional message to send to text channel
   */
  destroy(reason) {
    logger.info(MOD, `Destroying session for ${this.channelId}: ${reason || 'manual'}`);

    clearInterval(this._idleTimer);
    clearTimeout(this._hardTimer);

    // Clean up receivers
    for (const [, recv] of this.receivers) {
      recv.destroy();
    }
    this.receivers.clear();

    // Stop audio
    this.audioPlayer.stop();

    // Clear LLM history
    clearHistory(this.channelId);

    // Disconnect
    try {
      this.connection.destroy();
    } catch { /* already destroyed */ }

    this.state = 'destroyed';
  }
}
