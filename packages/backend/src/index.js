import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { mountFrontend } from './static.js';
import { spawn } from 'child_process';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// serve frontend
mountFrontend(app);

const server = http.createServer(app);

// Frontend client <-> Backend WS
const clientWss = new WebSocketServer({ server, path: '/ws' });

// Util: connect to OpenAI Realtime WS for transcription
function connectRealtimeSession() {
  const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-transcribe';
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

  const openaiWs = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  return openaiWs;
}

// Broadcast helper
function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

clientWss.on('connection', (client) => {
  const openai = connectRealtimeSession();

  const pendingClientMessages = [];
  let speakerProc = null;

  openai.on('open', () => {
    // Configure session for transcription mode + VAD, language, etc
    const language = process.env.TRANSCRIPTION_LANGUAGE || 'en';
    const transcriptionModel = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-transcribe';
    const vadThreshold = Number(process.env.VAD_THRESHOLD || 0.5);
    const vadPrefixPaddingMs = Number(process.env.VAD_PREFIX_PADDING_MS || 300);
    const vadSilenceDurationMs = Number(process.env.VAD_SILENCE_DURATION_MS || 500);
    const rate = Number(process.env.AUDIO_RATE || 24000);

    const sessionUpdate = {
      type: 'session.update',
      session: {
        // Configure transcription-only behavior
        model: transcriptionModel,
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: transcriptionModel,
          language,
          prompt: process.env.TRANSCRIPTION_PROMPT || ''
        },
        turn_detection: process.env.VAD_ENABLED === 'false' ? null : {
          type: 'server_vad',
          threshold: vadThreshold,
          prefix_padding_ms: vadPrefixPaddingMs,
          silence_duration_ms: vadSilenceDurationMs,
        }
      }
    };

    safeSend(openai, JSON.stringify(sessionUpdate));

    // Flush any queued messages from client while connecting
    while (pendingClientMessages.length) {
      safeSend(openai, pendingClientMessages.shift());
    }
  });

  // Pipe client -> OpenAI (binary audio and control JSON)
  client.on('message', (raw, isBinary) => {
    // Client sends either JSON control messages or binary PCM frames
    if (isBinary || typeof raw !== 'string') {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (!buf || buf.length === 0) return;
      // ensure 16-bit alignment
      if (buf.length % 2 !== 0) return;
      // Wrap audio chunk into input_audio_buffer.append event
      const base64 = buf.toString('base64');
      if (base64.length === 0) return;
      const evt = {
        type: 'input_audio_buffer.append',
        audio: base64,
      };
      const msg = JSON.stringify(evt);
      if (openai.readyState === WebSocket.OPEN) safeSend(openai, msg);
      else pendingClientMessages.push(msg);
      return;
    }

    // Try to forward JSON control messages
    try {
      const txt = typeof raw === 'string' ? raw : raw.toString();
      const maybe = JSON.parse(txt);
      // Handle special backend-driven speaker capture commands
      if (maybe && typeof maybe === 'object' && maybe.type === 'speaker.capture.start') {
        if (speakerProc) return; // already running
        const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
        const device = process.env.SPEAKER_DEVICE || 'virtual-audio-capturer';
        // Windows dshow loopback device often 'virtual-audio-capturer' or 'Stereo Mix (Realtek(R) Audio)'
        const args = [
          '-f', 'dshow',
          '-i', `audio=${device}`,
          '-ac', '1',
          '-ar', String(Number(process.env.AUDIO_RATE || 24000)),
          '-f', 's16le',
          'pipe:1'
        ];
        speakerProc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        speakerProc.stdout.on('data', (chunk) => {
          if (!chunk || chunk.length === 0) return;
          if (openai.readyState !== WebSocket.OPEN) return;
          // Ensure 16-bit alignment
          const buf = Buffer.from(chunk);
          if (buf.length % 2 !== 0) return;
          const base64 = buf.toString('base64');
          if (!base64) return;
          const evt = { type: 'input_audio_buffer.append', audio: base64 };
          safeSend(openai, JSON.stringify(evt));
        });
        speakerProc.stderr.on('data', () => {});
        speakerProc.on('close', () => { speakerProc = null; });
        return;
      }
      if (maybe && typeof maybe === 'object' && maybe.type === 'speaker.capture.stop') {
        if (speakerProc) {
          try { speakerProc.kill('SIGTERM'); } catch {}
          speakerProc = null;
        }
        // Commit turn after stopping
        if (openai.readyState === WebSocket.OPEN) {
          safeSend(openai, JSON.stringify({ type: 'input_audio_buffer.commit' }));
        }
        return;
      }

      // Forward other JSON control messages to OpenAI
      if (openai.readyState === WebSocket.OPEN) safeSend(openai, txt);
      else pendingClientMessages.push(txt);
    } catch {}
  });

  // Pipe OpenAI -> client (transcription events)
  openai.on('message', (data) => {
    // We forward server events to client UI
    safeSend(client, data);
  });

  const cleanup = () => {
    if (speakerProc) {
      try { speakerProc.kill('SIGTERM'); } catch {}
      speakerProc = null;
    }
    try { openai.close(); } catch {}
    try { client.close(); } catch {}
  };

  client.on('close', cleanup);
  client.on('error', cleanup);
  openai.on('close', cleanup);
  openai.on('error', cleanup);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${PORT}`);
});


