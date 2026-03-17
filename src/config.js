import 'dotenv/config';

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
  },
  deepgram: {
    apiKey: process.env.DEEPGRAM_API_KEY,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  voice: {
    maxSessionMinutes: parseInt(process.env.VOICE_MAX_SESSION_MINUTES || '30', 10),
    idleTimeoutMinutes: parseInt(process.env.VOICE_IDLE_TIMEOUT_MINUTES || '5', 10),
    maxConcurrent: parseInt(process.env.VOICE_MAX_CONCURRENT || '1', 10),
    speechThreshold: 0.01,
    silenceDurationMs: 350,
  },
  llm: {
    model: 'claude-sonnet-4-6',
    maxTokens: 300,
    maxHistory: 20,
    systemPrompt: `You are Lodekeeper, an AI assistant in a Discord voice channel. Keep responses brief and conversational — 1-3 sentences max unless asked for detail. You're a technical AI focused on Ethereum and Lodestar development. Be direct and helpful. Don't use markdown formatting since your responses will be spoken aloud.`,
  },
  tts: {
    model: 'tts-1',
    voice: 'onyx',
  },
};
