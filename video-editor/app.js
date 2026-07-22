import { detectSilenceKeepSegments, totalKeepDuration, computeWaveformPeaks } from "./silence.js";
import { BGM_PRESETS, SFX_PRESETS, generateBgmBuffer, generateSfxBuffer, audioBufferToWav } from "./audio-gen.js";
import { decodeToMono16k, transcribeAudio, buildVtt } from "./transcribe.js";
import { getFFmpeg, cutSilenceSegments, mixFinalAudio } from "./ffmpeg-pipeline.js";

const el = (id) => document.getElementById(id);

const state = {
  videoFile: null,
  analysis: null,
  keepSegments: null,
  cutVideoBytes: null,
  cutDurationSeconds: 0,
  transcriptSegments: [],
  bgmFile: null,
};

function setStepEnabled(sectionId, enabled) {
  el(sectionId).dataset.disabled = enabled ? "false" : "true";
}

function extOf(file) {
  const m = (file.name || "").match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "mp4";
}

// ---------- Step 1: upload ----------

const dropzone = el("dropzone");
const fileInput = el("file-input");
const previewVideo = el("preview-video");

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleVideoFile(file);
});
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handleVideoFile(file);
});

async function handleVideoFile(file) {
  state.videoFile = file;
  previewVideo.src = URL.createObjectURL(file);
  el("upload-info").textContent = "音声を解析しています…";

  setStepEnabled("step-cut", true);
  setStepEnabled("step-subtitle", false);
  setStepEnabled("step-audio", false);
  setStepEnabled("step-export", false);
  el("apply-cut-btn").disabled = true;

  const arrayBuffer = await file.arrayBuffer();
  state.analysis = await decodeToMono16k(arrayBuffer);
  el("upload-info").textContent = `読み込み完了（長さ: ${state.analysis.duration.toFixed(1)}秒）`;
}

// ---------- Step 2: silence cut ----------

const thresholdSlider = el("threshold-slider");
const minSilenceSlider = el("min-silence-slider");
const paddingSlider = el("padding-slider");

thresholdSlider.addEventListener("input", () => {
  el("threshold-value").textContent = `${thresholdSlider.value} dB`;
});
minSilenceSlider.addEventListener("input", () => {
  el("min-silence-value").textContent = `${minSilenceSlider.value} 秒`;
});
paddingSlider.addEventListener("input", () => {
  el("padding-value").textContent = `${paddingSlider.value} 秒`;
});

el("analyze-btn").addEventListener("click", () => {
  if (!state.analysis) return;
  const { samples, sampleRate, duration } = state.analysis;
  const keepSegments = detectSilenceKeepSegments(samples, sampleRate, {
    thresholdDb: Number(thresholdSlider.value),
    minSilenceSeconds: Number(minSilenceSlider.value),
    paddingSeconds: Number(paddingSlider.value),
  });
  state.keepSegments = keepSegments;
  drawWaveform(samples, duration, keepSegments);

  const keptDuration = totalKeepDuration(keepSegments);
  const cutDuration = duration - keptDuration;
  el("analyze-info").textContent =
    `元の長さ: ${duration.toFixed(1)}秒 → カット後: ${keptDuration.toFixed(1)}秒` +
    `（${cutDuration.toFixed(1)}秒を削減、区間数: ${keepSegments.length}）`;
  el("apply-cut-btn").disabled = false;
});

function drawWaveform(samples, duration, keepSegments) {
  const canvas = el("waveform-canvas");
  const width = (canvas.width = canvas.clientWidth || 700);
  const height = (canvas.height = 80);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);

  const peaks = computeWaveformPeaks(samples, width);
  ctx.fillStyle = "#c7cbe0";
  const mid = height / 2;
  for (let x = 0; x < width; x++) {
    const h = Math.max(1, peaks[x] * height);
    ctx.fillRect(x, mid - h / 2, 1, h);
  }

  ctx.fillStyle = "rgba(255, 90, 90, 0.35)";
  let cursor = 0;
  for (const seg of keepSegments) {
    const gapStartX = (cursor / duration) * width;
    const gapEndX = (seg.start / duration) * width;
    if (gapEndX > gapStartX) ctx.fillRect(gapStartX, 0, gapEndX - gapStartX, height);
    cursor = seg.end;
  }
  if (cursor < duration) {
    const gapStartX = (cursor / duration) * width;
    ctx.fillRect(gapStartX, 0, width - gapStartX, height);
  }
}

el("apply-cut-btn").addEventListener("click", async () => {
  const btn = el("apply-cut-btn");
  btn.disabled = true;
  const progressWrap = el("cut-progress-wrap");
  const progressFill = el("cut-progress-fill");
  const progressText = el("cut-progress-text");
  progressWrap.hidden = false;
  progressText.textContent = "ffmpegを準備しています…";

  try {
    const ffmpeg = await getFFmpeg();
    const data = await cutSilenceSegments(ffmpeg, state.videoFile, state.keepSegments, (progress) => {
      const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `カット処理中… ${pct}%`;
    });

    state.cutVideoBytes = data;
    state.cutDurationSeconds = totalKeepDuration(state.keepSegments);

    const blob = new Blob([data], { type: "video/mp4" });
    previewVideo.src = URL.createObjectURL(blob);
    progressText.textContent = "カット完了！";

    setStepEnabled("step-subtitle", true);
    setStepEnabled("step-audio", true);
    setStepEnabled("step-export", true);
  } catch (err) {
    console.error(err);
    progressText.textContent = `エラーが発生しました: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Step 3: transcription & subtitles ----------

const subtitleOverlay = el("subtitle-overlay");

el("transcribe-btn").addEventListener("click", async () => {
  const btn = el("transcribe-btn");
  btn.disabled = true;
  const progressWrap = el("model-progress-wrap");
  const progressFill = el("model-progress-fill");
  const progressText = el("model-progress-text");
  progressWrap.hidden = false;
  progressText.textContent = "モデルを読み込んでいます…";

  try {
    const blob = new Blob([state.cutVideoBytes], { type: "video/mp4" });
    const { samples } = await decodeToMono16k(await blob.arrayBuffer());

    const segments = await transcribeAudio(samples, (progress) => {
      if (progress.status === "progress" && progress.total) {
        const pct = Math.round((progress.loaded / progress.total) * 100);
        progressFill.style.width = `${pct}%`;
        progressText.textContent = `モデルを読み込み中… ${pct}% (${progress.file || ""})`;
      } else if (progress.status) {
        progressText.textContent = `準備中: ${progress.status}`;
      }
    });

    progressText.textContent = "文字起こし完了！";
    state.transcriptSegments = segments;
    renderTranscriptList(segments);
    el("download-vtt-btn").disabled = false;
  } catch (err) {
    console.error(err);
    progressText.textContent = `エラーが発生しました: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

function renderTranscriptList(segments) {
  const listEl = el("transcript-list");
  listEl.innerHTML = "";
  segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "transcript-row";

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = `${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s`;

    const textarea = document.createElement("textarea");
    textarea.value = seg.text;
    textarea.addEventListener("input", () => {
      state.transcriptSegments[i].text = textarea.value;
    });

    row.appendChild(time);
    row.appendChild(textarea);
    listEl.appendChild(row);
  });
}

previewVideo.addEventListener("timeupdate", () => {
  if (!el("show-subtitle-checkbox").checked || state.transcriptSegments.length === 0) {
    subtitleOverlay.textContent = "";
    return;
  }
  const t = previewVideo.currentTime;
  const active = state.transcriptSegments.find((s) => t >= s.start && t <= s.end);
  subtitleOverlay.textContent = active ? active.text : "";
});

el("download-vtt-btn").addEventListener("click", () => {
  const vtt = buildVtt(state.transcriptSegments);
  const blob = new Blob([vtt], { type: "text/vtt" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "subtitles.vtt";
  a.click();
});

// ---------- Step 4: BGM / SFX ----------

const bgmPresetSelect = el("bgm-preset-select");
BGM_PRESETS.forEach((p) => {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = `${p.label} - ${p.description}`;
  bgmPresetSelect.appendChild(opt);
});

const sfxPresetSelect = el("sfx-preset-select");
SFX_PRESETS.forEach((p) => {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.label;
  sfxPresetSelect.appendChild(opt);
});

el("bgm-enable-checkbox").addEventListener("change", (e) => {
  el("bgm-options").hidden = !e.target.checked;
});
el("sfx-enable-checkbox").addEventListener("change", (e) => {
  el("sfx-options").hidden = !e.target.checked;
});

document.querySelectorAll('input[name="bgm-source"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const useUpload = document.querySelector('input[name="bgm-source"]:checked').value === "upload";
    el("bgm-preset-wrap").hidden = useUpload;
    el("bgm-upload-wrap").hidden = !useUpload;
  });
});

el("bgm-file-input").addEventListener("change", (e) => {
  state.bgmFile = e.target.files[0] || null;
});

let previewAudioEl = null;
function playBufferPreview(buffer) {
  if (previewAudioEl) {
    previewAudioEl.pause();
  }
  const wav = audioBufferToWav(buffer);
  const blob = new Blob([wav], { type: "audio/wav" });
  previewAudioEl = new Audio(URL.createObjectURL(blob));
  previewAudioEl.play();
}

el("bgm-preview-btn").addEventListener("click", async () => {
  const buffer = await generateBgmBuffer(bgmPresetSelect.value, 6);
  playBufferPreview(buffer);
});

el("sfx-preview-btn").addEventListener("click", async () => {
  const buffer = await generateSfxBuffer(sfxPresetSelect.value);
  playBufferPreview(buffer);
});

// ---------- Step 5: export ----------

function computeSfxTimes(keepSegments) {
  const times = [];
  let acc = 0;
  for (let i = 0; i < keepSegments.length; i++) {
    acc += keepSegments[i].end - keepSegments[i].start;
    if (i < keepSegments.length - 1) times.push(acc);
  }
  return times.slice(0, 20);
}

el("export-btn").addEventListener("click", async () => {
  const btn = el("export-btn");
  btn.disabled = true;
  const progressWrap = el("export-progress-wrap");
  const progressFill = el("export-progress-fill");
  const progressText = el("export-progress-text");
  progressWrap.hidden = false;
  progressText.textContent = "準備中…";

  try {
    const options = { durationSeconds: state.cutDurationSeconds };

    if (el("bgm-enable-checkbox").checked) {
      const useUpload = document.querySelector('input[name="bgm-source"]:checked').value === "upload";
      if (useUpload && state.bgmFile) {
        options.bgmBytes = new Uint8Array(await state.bgmFile.arrayBuffer());
        options.bgmExt = extOf(state.bgmFile);
      } else {
        progressText.textContent = "BGMを生成しています…";
        const buffer = await generateBgmBuffer(bgmPresetSelect.value, state.cutDurationSeconds);
        options.bgmBytes = audioBufferToWav(buffer);
        options.bgmExt = "wav";
      }
      options.bgmVolume = Number(el("bgm-volume-slider").value);
    }

    if (el("sfx-enable-checkbox").checked) {
      progressText.textContent = "効果音を生成しています…";
      const buffer = await generateSfxBuffer(sfxPresetSelect.value);
      options.sfxBytes = audioBufferToWav(buffer);
      options.sfxTimes = computeSfxTimes(state.keepSegments);
    }

    progressText.textContent = "動画を書き出しています…";
    const ffmpeg = await getFFmpeg();
    const finalData = await mixFinalAudio(ffmpeg, state.cutVideoBytes, options, (progress) => {
      const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `書き出し中… ${pct}%`;
    });

    const blob = new Blob([finalData], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    el("result-video").src = url;
    const link = el("download-video-link");
    link.href = url;
    el("export-result").hidden = false;
    progressText.textContent = "書き出し完了！";
  } catch (err) {
    console.error(err);
    progressText.textContent = `エラーが発生しました: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
