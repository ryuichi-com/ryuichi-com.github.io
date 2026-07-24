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
      // Word-level timestamps let the main thread regroup text into subtitle-length
      // cues that break at punctuation, instead of being stuck with whisper's raw
      // fixed-size chunk boundaries (which often cut mid-sentence).
      return_timestamps: "word",
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    self.postMessage({ type: "result", output });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
