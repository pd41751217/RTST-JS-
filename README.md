## Realtime Transcription (WebSocket)

Backend (Node/Express) bridges your browser to OpenAI Realtime Transcription over secure server‑side WebSocket. Frontend streams microphone audio and renders incremental and final transcripts.

### Prerequisites
- Node 18+
- An OpenAI API Key with Realtime access

### Setup
1. Install dependencies (root will install workspaces):
   ```bash
   npm install --workspaces
   ```
2. Configure environment (copy and edit):
   - Create `packages/backend/.env` with:
     ```env
     PORT=3001
     OPENAI_API_KEY=YOUR_KEY
     OPENAI_REALTIME_MODEL=gpt-realtime
     TRANSCRIPTION_MODEL=gpt-4o-transcribe
     TRANSCRIPTION_LANGUAGE=en
     TRANSCRIPTION_PROMPT=
     VAD_ENABLED=true
     VAD_THRESHOLD=0.5
     VAD_PREFIX_PADDING_MS=300
     VAD_SILENCE_DURATION_MS=500
     NOISE_REDUCTION=near_field
     AUDIO_RATE=24000
     ```

### Run
```bash
npm run dev
```

Open `http://localhost:3001/` in your browser.

### How it works
- The backend opens `wss://api.openai.com/v1/realtime?model=...` and sends a `session.update` to enable transcription mode and VAD.
- The frontend captures microphone audio, downsamples to 24kHz PCM16 frames, and streams binary frames over `ws://localhost:3001/ws`.
- Transcription delta and completed events are forwarded to the browser and rendered.

### Controls
- Start/Stop Mic
- Commit Turn: forces buffer commit when VAD is disabled or when you want to cut a turn.
- VAD toggle and silence duration: overrides session settings client-side.

### Notes
- For production, consider a higher quality resampler and backpressure handling.
- Do not expose your OpenAI API key to the frontend; it only lives on the backend.


