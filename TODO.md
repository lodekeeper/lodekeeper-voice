# Discord Voice Bridge — Open TODOs

Last updated: 2026-03-17

## 🔴 Must Fix (before next test)

### 1. Graceful shutdown
- SIGTERM handler exists but SIGKILL leaves bot visible in voice channel for ~60s
- REST API `me.voice.disconnect()` fails with Missing Permissions (50013)
- Current workaround: spin up new client → gateway opcode 4 disconnect
- **Fix:** Add `MOVE_MEMBERS` permission to bot in Discord, OR implement a proper shutdown script that the process manager calls before SIGKILL

### 2. Anthropic API key
- Secondary profile key (`sk-ant-oat01-...`) returns HTTP 400
- Primary key uses `ref(file:/providers/anthropic/apiToken)` — file doesn't exist on disk
- Currently using OpenAI `gpt-4.1-mini` as workaround
- **Fix:** Get a working Anthropic key into `.env`, or keep OpenAI and tune the model choice

### 3. Whisper hallucinations on non-speech audio
- Background noise/music transcribed as "You", ".", "Music Music Music", random sentences
- 30s turn cap and 0.5s minimum filter help but don't eliminate the problem
- **Fix options:**
  - Add a pre-STT energy/SNR gate (reject turns where avg RMS is near threshold)
  - Switch to Deepgram which handles noise better
  - Add post-STT filter: reject transcripts that are single words like "You", ".", "Bye" when confidence is low

### 4. Deepgram integration
- No Deepgram API key configured — STT falls back to Whisper (~1-2s per transcription)
- Deepgram Nova-3 supports streaming (would reduce latency to ~200-500ms)
- **Fix:** Sign up for Deepgram free tier, add key to `.env`, test streaming mode

## 🟡 Should Fix (quality improvements)

### 5. Interruption handling
- Bot finishes speaking even if someone talks over it
- Should detect speech during playback and stop TTS, process new input
- **Fix:** Monitor `speaking.on('start')` during `speaking` state → stop AudioPlayer → process new turn

### 6. Single Opus decoder shared across users
- `const encoder = new OpusEncoder(...)` is module-level singleton
- Opus decoders are stateful — shared decoder across users may cause audio corruption
- **Fix:** Create one OpusEncoder per UserAudioReceiver instance

### 7. Audio subscription lifecycle
- `receiver.subscribe(userId, { end: { behavior: 'manual' } })` never gets cleaned up
- When users leave the channel, their subscription and UserAudioReceiver persist
- **Fix:** Listen for `voiceStateUpdate` events, clean up receivers when users leave

### 8. Queue strategy
- Current: FIFO with max 3, drop oldest
- Better: prioritize the user who was last addressed, or the user who hasn't spoken recently
- Consider: skip queue entirely when in `speaking` state (only process after done speaking)

### 9. Speaker-aware conversation
- LLM gets `[Name]: text` format but has no context about who's in the channel
- Could inject channel member list into system prompt
- Could track who the bot was talking to and prioritize that thread

### 10. Bot speaking to itself
- If the bot's TTS output leaks back through the audio receiver, it could create a feedback loop
- Currently mitigated by `selfDeaf: false` — but we should verify the bot's own audio isn't being received
- **Fix:** Filter out the bot's own userId from `speaking.on('start')` events

## 🟢 Nice to Have (future)

### 11. pm2 deployment
- Currently started manually via `node src/voice-bridge.js`
- Should run as a pm2 service for persistence and auto-restart
- Add `ecosystem.config.cjs` for pm2

### 12. Slash command improvements
- `/voicejoin` could accept a channel argument (join a specific channel without being in it)
- `/voiceleave` should work from any text channel, not require being in the voice channel
- Add `/voicereset` to clear conversation history

### 13. Text channel integration
- Send transcripts to a linked text channel for logging
- Allow text-channel messages to be included in voice conversation context

### 14. Multi-guild support
- Currently limited to `maxConcurrent: 1` session
- Architecture supports multi-guild but untested

### 15. Metrics/monitoring
- Track latency per stage (STT, LLM, TTS)
- Track turn count, error rate, queue depth over time
- Expose via a simple HTTP endpoint or log to file

### 16. Wake word / push-to-talk mode
- Currently always listening — responds to everything
- Option: only respond when addressed ("Hey Lodekeeper, ...")
- Option: push-to-talk via a Discord bot button

### 17. Voice selection
- Currently hardcoded to OpenAI `tts-1` with voice `onyx`
- Could make configurable via `.env` or slash command
- ElevenLabs integration for higher quality voices

## 📝 Lessons Learned

1. **Always verify function signatures match across modules** — the 4-arg vs 3-arg mismatch was the #1 bug and could have been caught with a simple grep
2. **Discord audio subscriptions multiply if you re-subscribe on every `speaking.start`** — subscribe once per user
3. **Whisper hallucinates on silence/noise** — need pre-STT filtering or Deepgram
4. **SIGKILL doesn't trigger process event handlers** — need external shutdown coordination for voice disconnect
5. **Discord voice state persists ~60s after abrupt disconnect** — plan for this in UX
6. **Codex CLI needs a git repo and generous timeout** — init git before launching, use timeout:3600+
7. **The OpenClaw bot token is shared** — voice bridge and text bot use the same token/identity
