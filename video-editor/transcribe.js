let worker = null;

// The whisper model download + the transcription inference itself are both heavy,
// CPU-bound work. Running them on the main thread (as a plain async function call)
// still blocks all rendering and input handling for as long as they take, which for a
// long recording is minutes — long enough for the browser to consider the tab hung.
// Doing this in a dedicated worker keeps the page responsive throughout.
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./transcribe-worker.js?v=4", import.meta.url), { type: "module" });
  }
  return worker;
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

const SENTENCE_END_PATTERN = /[。！？!?]$/;

// Whisper's chunk-level output (word-level timestamps aren't supported for whisper in
// this version of transformers.js — see transcribe-worker.js) is re-grouped into
// subtitle-length cues here. Adjacent chunks are merged until a sentence-ending
// punctuation mark or a length/duration limit is hit; a single chunk longer than that
// is left as its own cue rather than being cut mid-sentence.
export function regroupIntoSubtitleSegments(chunks, { maxDurationSec = 6, maxChars = 24 } = {}) {
  const segments = [];
  let current = null;

  for (const chunk of chunks) {
    const text = (chunk.text || "").trim();
    if (!text) continue;
    const start = chunk.timestamp?.[0] ?? 0;
    const end = chunk.timestamp?.[1] ?? start;

    if (!current) {
      current = { start, end, text };
      continue;
    }

    const mergedText = current.text + text;
    const mergedDuration = end - current.start;
    const shouldBreak =
      SENTENCE_END_PATTERN.test(current.text) || mergedDuration > maxDurationSec || mergedText.length > maxChars;

    if (shouldBreak) {
      segments.push(current);
      current = { start, end, text };
    } else {
      current.text = mergedText;
      current.end = end;
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function transcribeAudio(samples, modelId, onProgress) {
  const w = getWorker();
  // getChannelData() may return a view backed by the AudioBuffer's own storage, so copy
  // before transferring ownership of the underlying buffer to the worker.
  const samplesCopy = samples.slice();

  return new Promise((resolve, reject) => {
    function handleMessage(event) {
      const { type } = event.data;
      if (type === "progress") {
        if (onProgress) onProgress(event.data.progress);
        return;
      }
      w.removeEventListener("message", handleMessage);
      if (type === "error") {
        reject(new Error(event.data.message));
        return;
      }

      const output = event.data.output;
      const chunks = output.chunks || [{ timestamp: [0, samplesCopy.length / 16000], text: output.text }];
      resolve(regroupIntoSubtitleSegments(chunks));
    }

    w.addEventListener("message", handleMessage);
    w.postMessage({ type: "transcribe", samples: samplesCopy, modelId }, [samplesCopy.buffer]);
  });
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
