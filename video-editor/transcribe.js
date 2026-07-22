let transcriberPromise = null;

async function loadTransformers() {
  return import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js");
}

export async function loadTranscriber(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await loadTransformers();
      env.allowLocalModels = false;
      return pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
        quantized: true,
        progress_callback: (progress) => {
          if (onProgress) onProgress(progress);
        },
      });
    })();
  }
  return transcriberPromise;
}

export async function decodeToMono16k(arrayBuffer) {
  const AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0));
  await tempCtx.close();

  const targetRate = 16000;
  const offline = new AudioCtx(1, Math.ceil(decoded.duration * targetRate), targetRate);
  const source = offline.createBufferSource();

  if (decoded.numberOfChannels > 1) {
    const monoBuffer = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const monoData = monoBuffer.getChannelData(0);
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const chData = decoded.getChannelData(ch);
      for (let i = 0; i < chData.length; i++) monoData[i] += chData[i] / decoded.numberOfChannels;
    }
    source.buffer = monoBuffer;
  } else {
    source.buffer = decoded;
  }

  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), sampleRate: targetRate, duration: decoded.duration };
}

export async function transcribeAudio(samples, onProgress) {
  const transcriber = await loadTranscriber(onProgress);
  const output = await transcriber(samples, {
    language: "japanese",
    task: "transcribe",
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const chunks = output.chunks || [{ timestamp: [0, samples.length / 16000], text: output.text }];
  return chunks
    .filter((c) => c.text && c.text.trim().length > 0)
    .map((c) => ({
      start: c.timestamp[0] ?? 0,
      end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 2,
      text: c.text.trim(),
    }));
}

function formatVttTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
}

export function buildVtt(segments) {
  const lines = ["WEBVTT", ""];
  segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}`);
    lines.push(seg.text);
    lines.push("");
  });
  return lines.join("\n");
}
