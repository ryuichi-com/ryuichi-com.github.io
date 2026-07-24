let transcriberPromise = null;
let transcriberModelId = null;

async function loadTransformers() {
  return import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js");
}

async function getTranscriber(modelId, onProgress) {
  if (!transcriberPromise || transcriberModelId !== modelId) {
    transcriberModelId = modelId;
    transcriberPromise = (async () => {
      const { pipeline, env } = await loadTransformers();
      env.allowLocalModels = false;
      return pipeline("automatic-speech-recognition", modelId, {
        quantized: true,
        progress_callback: onProgress,
      });
    })();
  }
  return transcriberPromise;
}

self.onmessage = async (event) => {
  if (event.data.type !== "transcribe") return;

  try {
    const modelId = event.data.modelId || "Xenova/whisper-base";
    const transcriber = await getTranscriber(modelId, (progress) => {
      self.postMessage({ type: "progress", progress });
    });

    const output = await transcriber(event.data.samples, {
      language: "japanese",
      task: "transcribe",
      // NOTE: return_timestamps: "word" throws "Unsupported model type: whisper" in
      // @xenova/transformers@2.17.2 — word-level timestamp extraction isn't wired up
      // for whisper in this version, so every model fails identically. Chunk-level
      // timestamps are the only mode that actually works for whisper here.
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    self.postMessage({ type: "result", output });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
