import { createAudioResource, createAudioPlayer, AudioPlayerStatus, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { Readable } from 'node:stream';
import { logger } from './logger.js';

const MOD = 'audio-play';

/**
 * Manages audio playback into a Discord voice connection.
 */
export class VoicePlayer {
  constructor() {
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });
    this.isPlaying = false;
    this.currentAbort = null;

    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        this.isPlaying = false;
        logger.debug(MOD, 'Playback finished');
      }
      if (newState.status === AudioPlayerStatus.Playing) {
        this.isPlaying = true;
        logger.debug(MOD, 'Playback started');
      }
    });

    this.player.on('error', (err) => {
      logger.error(MOD, `Player error: ${err.message}`);
      this.isPlaying = false;
    });
  }

  /**
   * Play an MP3 audio buffer through the voice connection.
   * @param {Buffer} mp3Buffer - MP3 audio data from TTS
   * @returns {Promise<void>} Resolves when playback finishes or is interrupted
   */
  play(mp3Buffer) {
    return new Promise((resolve, reject) => {
      if (!mp3Buffer || mp3Buffer.length === 0) {
        resolve();
        return;
      }

      try {
        const stream = Readable.from(mp3Buffer);
        const resource = createAudioResource(stream, {
          inputType: StreamType.OggOpus,
        });

        const onIdle = (oldState, newState) => {
          if (newState.status === AudioPlayerStatus.Idle) {
            this.player.removeListener('stateChange', onIdle);
            resolve();
          }
        };

        this.player.on('stateChange', onIdle);
        this.player.play(resource);
        logger.info(MOD, `Playing ${mp3Buffer.length} bytes of audio`);
      } catch (err) {
        logger.error(MOD, `Play error: ${err.message}`);
        reject(err);
      }
    });
  }

  /**
   * Stop current playback immediately (for interruption).
   */
  stop() {
    if (this.isPlaying) {
      this.player.stop(true);
      this.isPlaying = false;
      logger.info(MOD, 'Playback stopped (interrupted)');
    }
  }

  /**
   * Get the underlying AudioPlayer for subscribing to a connection.
   */
  getPlayer() {
    return this.player;
  }
}
