let worker = null;

// The whisper model download + the transcription inference itself are both heavy,
// CPU-bound work. Running them on the main thread (as a plain async function call)
// still blocks all rendering and input handling for as long as they take, which for a
// long recording is minutes — long enough for the browser to consider the tab hung.
// Doing this in a dedicated worker keeps the page responsive throughout.
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./transcribe-worker.js", import.meta.url), { type: "module" });
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

export function transcribeAudio(samples, onProgress) {
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
      resolve(
        chunks
          .filter((c) => c.text && c.text.trim().length > 0)
          .map((c) => ({
            start: c.timestamp[0] ?? 0,
            end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 2,
            text: c.text.trim(),
          }))
      );
    }

    w.addEventListener("message", handleMessage);
    w.postMessage({ type: "transcribe", samples: samplesCopy }, [samplesCopy.buffer]);
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
