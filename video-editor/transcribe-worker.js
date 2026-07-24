let transcriberPromise = null;

async function loadTransformers() {
  return import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js");
}

async function getTranscriber(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await loadTransformers();
      env.allowLocalModels = false;
      return pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
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
    const transcriber = await getTranscriber((progress) => {
      self.postMessage({ type: "progress", progress });
    });

    const output = await transcriber(event.data.samples, {
      language: "japanese",
      task: "transcribe",
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    self.postMessage({ type: "result", output });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
