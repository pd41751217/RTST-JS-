const statusEl = document.getElementById('status');
const connectBtn = document.getElementById('connectBtn');
const micBtn = document.getElementById('micBtn');
const speakerBtn = document.getElementById('speakerBtn');
const commitBtn = document.getElementById('commitBtn');
const transcriptsEl = document.getElementById('transcripts');
const debugEl = document.getElementById('debug');
const vadEnabledEl = document.getElementById('vadEnabled');
const silenceMsEl = document.getElementById('silenceMs');

let ws;
let mediaStream;
let audioContext;
let processorNode;
let sourceNode;
let speakerCapturing = false;

const TARGET_RATE = 24000; // must match backend session.update

function setStatus(text) {
  statusEl.textContent = text;
}

function appendLiveText(text) {
  let live = transcriptsEl.querySelector('.live');
  if (!live) {
    live = document.createElement('div');
    live.className = 'live mono';
    transcriptsEl.appendChild(live);
  }
  live.textContent = text;
}

function finalizeLiveText(full) {
  const live = transcriptsEl.querySelector('.live');
  if (live) {
    live.remove();
  }
  const line = document.createElement('div');
  line.className = 'final mono';
  line.textContent = full;
  transcriptsEl.appendChild(line);
}

function logDebug(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  debugEl.textContent = s;
}

function floatToPcm16(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Simple linear resampler (good enough for voice). For production, use a high-quality resampler.
function resampleLinear(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const newLength = Math.floor(input.length / ratio);
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = idx - i0;
    output[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return output;
}

async function startMic() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  processorNode.onaudioprocess = (event) => {
    const inBuf = event.inputBuffer.getChannelData(0);
    const resampled = resampleLinear(inBuf, audioContext.sampleRate, TARGET_RATE);
    const pcm16 = floatToPcm16(resampled);
    ws.send(pcm16.buffer);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
  micBtn.textContent = 'Stop Mic';
}

function stopMic() {
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (audioContext) audioContext.close();
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  processorNode = null; sourceNode = null; audioContext = null; mediaStream = null;
  micBtn.textContent = 'Start Mic';
}

async function startSpeaker() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Stop mic if running
  if (mediaStream) stopMic();
  // Capture system audio via display media (tab/system audio depending on browser)
  mediaStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  // Some browsers require enabling "Share audio" on the picker
  audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  processorNode.onaudioprocess = (event) => {
    const inBuf = event.inputBuffer.getChannelData(0);
    const resampled = resampleLinear(inBuf, audioContext.sampleRate, TARGET_RATE);
    const pcm16 = floatToPcm16(resampled);
    ws.send(pcm16.buffer);
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
  speakerBtn.textContent = 'Stop Speaker';
  setStatus('Speaker capture started (frontend)');
}

function stopSpeaker() {
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (audioContext) audioContext.close();
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  processorNode = null; sourceNode = null; audioContext = null; mediaStream = null;
  speakerBtn.textContent = 'Start Speaker';
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(`ws://${location.hostname}:3001/ws`);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    setStatus('Connected');
    micBtn.disabled = false;
    speakerBtn.disabled = false;
    commitBtn.disabled = false;

    // Send a session.update override if toggles changed
    const vadEnabled = vadEnabledEl.checked;
    const silenceMs = Number(silenceMsEl.value || '500');
    const sessionUpdate = {
      type: 'session.update',
      session: {
        input_audio_format: 'pcm16',
        turn_detection: vadEnabled ? { type: 'server_vad', silence_duration_ms: silenceMs } : null
      }
    };
    ws.send(JSON.stringify(sessionUpdate));
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected');
    micBtn.disabled = true;
    speakerBtn.disabled = true;
    commitBtn.disabled = true;
    stopMic();
    stopSpeaker();
  });

  ws.addEventListener('message', (ev) => {
    try {
      const data = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      console.log('Received event:', data.type, data);
      if (data.type === 'conversation.item.input_audio_transcription.delta') {
        appendLiveText(data.delta);
      } else if (data.type === 'conversation.item.input_audio_transcription.completed') {
        finalizeLiveText(data.transcript);
      } else if (data.type === 'error') {
        logDebug(data);
      }
    } catch (e) {
      // non-JSON, ignore
    }
  });
}

connectBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
});

micBtn.addEventListener('click', async () => {
  if (!mediaStream) await startMic(); else stopMic();
});

speakerBtn.addEventListener('click', async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!speakerCapturing) {
    // Try frontend-based capture first (browser screen sharing with audio)
    try {
      await startSpeaker();
      speakerCapturing = true;
    } catch (error) {
      console.log('Frontend speaker capture failed, trying backend method:', error);
      // Fallback to backend-based capture: no screen share. Requires ffmpeg + loopback device on server.
      ws.send(JSON.stringify({ type: 'speaker.capture.start' }));
      speakerBtn.textContent = 'Stop Speaker';
      speakerCapturing = true;
      setStatus('Speaker capture started (backend)');
      // Ensure mic is stopped on UI side
      if (mediaStream) stopMic();
    }
  } else {
    if (mediaStream) {
      // Frontend capture is active
      stopSpeaker();
    } else {
      // Backend capture is active
      ws.send(JSON.stringify({ type: 'speaker.capture.stop' }));
    }
    speakerBtn.textContent = 'Start Speaker';
    speakerCapturing = false;
  }
});

commitBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
});


