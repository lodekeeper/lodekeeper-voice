# Lodekeeper Voice Bridge — Implementation Guide

## What This Is
A standalone Node.js process that lets Lodekeeper join Discord voice channels, listen to users via STT, process with Claude, and respond with TTS audio.

## Architecture
See ~/research/discord-voice-bot/output.md and ~/research/discord-voice-bot/drafts/architecture.md for the full design. Key points:

- **Standalone process** — runs independently from OpenClaw
- **@discordjs/voice** for Discord audio (already installed)
- **Deepgram Nova-3 streaming** for STT
- **Claude Sonnet** (via @anthropic-ai/sdk) for LLM
- **OpenAI TTS** (tts-1, "onyx" voice) for speech synthesis
- MVP: Bridge manages its own conversation history (no OpenClaw IPC)

## File Structure
```
~/lodekeeper-voice/
  src/
    voice-bridge.js      — Main entry point, Discord client, slash commands
    audio-receiver.js    — Per-user audio stream handling, VAD, buffering
    stt-client.js        — Deepgram streaming STT client
    llm-client.js        — Anthropic Claude API wrapper with conversation history
    tts-client.js        — OpenAI TTS API wrapper, returns audio buffer
    audio-player.js      — Encode TTS output to Opus, play via @discordjs/voice AudioPlayer
    session-manager.js   — Per-channel voice session state (speakers, history, timing)
    config.js            — Environment config with defaults
    logger.js            — Simple structured logger
  .env.example           — Template for environment variables
  package.json           — Already created with deps installed
```

## Implementation Details

### voice-bridge.js (entry point)
- Create Discord.js Client with intents: Guilds, GuildVoiceStates, GuildMessages
- Register slash commands: /voicejoin, /voiceleave, /voicestatus
- On /voicejoin: join the user's current voice channel via joinVoiceChannel()
- On /voiceleave: destroy the voice connection
- Enforce max 1 concurrent voice channel
- Graceful shutdown on SIGTERM/SIGINT

### audio-receiver.js
- Subscribe to connection.receiver.subscribe(userId) for each speaking user
- Decode Opus → PCM using @discordjs/opus OpusEncoder
- Simple RMS-based VAD: track energy, detect speech start/end
- Speech threshold: 0.01 RMS
- Silence duration to end turn: 350ms
- Buffer PCM during speech, emit 'turn-complete' event with the audio buffer and userId
- Handle the Discord speaking events to know when users start/stop

### stt-client.js
- Use @deepgram/sdk createClient()
- For MVP: Use prerecorded (batch) transcription — send the complete PCM buffer after turn-end
  - This is simpler than streaming for v1
  - deepgram.listen.prerecorded.transcribeFile(buffer, { model: 'nova-3', language: 'en' })
- Return the transcript text
- Fallback: if DEEPGRAM_API_KEY not set, use OpenAI Whisper API as fallback

### llm-client.js
- Use @anthropic-ai/sdk Anthropic client
- Maintain conversation history per channel (Map<channelId, messages[]>)
- System prompt optimized for voice:
  "You are Lodekeeper, an AI assistant in a Discord voice channel. Keep responses brief and conversational — 1-3 sentences max unless asked for detail. You're a technical AI focused on Ethereum and Lodestar development. Be direct and helpful."
- Max history: 20 messages (rolling window)
- Model: claude-sonnet-4-6 (fast first-token)
- Max tokens: 300 (keep responses short for voice)

### tts-client.js
- Use openai npm package
- openai.audio.speech.create({ model: 'tts-1', voice: 'onyx', input: text, response_format: 'opus' })
- Return the audio buffer (Opus format, can be played directly by @discordjs/voice)
- If response_format 'opus' doesn't work with AudioPlayer, use 'mp3' and convert

### audio-player.js
- Create AudioPlayer from @discordjs/voice
- Create AudioResource from the TTS buffer (createAudioResource from stream)
- Subscribe the voice connection to the audio player
- Track playback state (idle/playing)
- Expose stop() for interruption handling
- On 'error' event: log and recover

### session-manager.js
- VoiceSession class per channel:
  - channelId, guildId
  - connection (VoiceConnection)
  - audioPlayer (AudioPlayer)
  - activeSpeaker: userId | null
  - speakerQueue: userId[]
  - conversationHistory: Message[]
  - lastActivity: timestamp
  - state: 'idle' | 'listening' | 'processing' | 'speaking'
- Idle timeout: 5 minutes → auto-leave
- Hard session cap: 30 minutes → auto-leave + notify in text
- State machine transitions as per architecture doc

### config.js
```javascript
export const config = {
  discord: { token: process.env.DISCORD_TOKEN },
  deepgram: { apiKey: process.env.DEEPGRAM_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY },
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  voice: {
    maxSessionMinutes: parseInt(process.env.VOICE_MAX_SESSION_MINUTES || '30'),
    idleTimeoutMinutes: parseInt(process.env.VOICE_IDLE_TIMEOUT_MINUTES || '5'),
    maxConcurrent: parseInt(process.env.VOICE_MAX_CONCURRENT || '1'),
    speechThreshold: 0.01,
    silenceDurationMs: 350,
  },
  llm: {
    model: 'claude-sonnet-4-6',
    maxTokens: 300,
    maxHistory: 20,
  },
  tts: {
    model: 'tts-1',
    voice: 'onyx',
  }
};
```

### .env.example
```
DISCORD_TOKEN=
DEEPGRAM_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
VOICE_MAX_SESSION_MINUTES=30
VOICE_IDLE_TIMEOUT_MINUTES=5
VOICE_MAX_CONCURRENT=1
LOG_LEVEL=info
```

## Important Notes
- Use ES modules (import/export) — package.json has "type": "module"
- All deps are already installed in node_modules
- The Discord bot token is the SAME one used by OpenClaw (shared token approach)
- For the Opus encoder, use: new OpusEncoder(48000, 2) from @discordjs/opus (or prism-media)
- Discord sends Opus at 48kHz stereo, Deepgram expects 16kHz mono PCM — need to resample
- For resampling: simple linear interpolation (48000→16000) or use ffmpeg
- @discordjs/voice AudioReceiveStream emits Opus packets — decode with OpusEncoder.decode()
- createAudioResource() can take a readable stream of Opus data or raw PCM

## Pre-push Checklist
- No lint errors
- Process starts without crashing
- Bot connects to Discord gateway
- Slash commands register
- /voicejoin successfully joins a voice channel
