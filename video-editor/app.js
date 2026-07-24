import { detectSilenceKeepSegments, totalKeepDuration, computeWaveformPeaks } from "./silence.js?v=4";
import { BGM_PRESETS, SFX_PRESETS, generateBgmBuffer, generateSfxBuffer, audioBufferToWav } from "./audio-gen.js?v=4";
import { decodeToMono16k, transcribeAudio, buildVtt } from "./transcribe.js?v=4";
import { getFFmpeg, cutSilenceSegments, mixFinalAudio, splitVideoIntoChunks } from "./ffmpeg-pipeline.js?v=4";
import { burnSubtitles } from "./burn-subtitles.js?v=4";

const el = (id) => document.getElementById(id);

const state = {
  videoFile: null,
  analysis: null,
  keepSegments: null,
  cutVideoBytes: null,
  cutDurationSeconds: 0,
  transcriptSegments: [],
  bgmFile: null,
  cutPointTimes: [],
  selectedCutPoints: new Set(),
  chunks: [],
  currentChunkIndex: null,
  subtitleStyle: {
    color: "#ffffff",
    strokeColor: "#000000",
    strokeRatio: 0.15,
    fontSizePercent: 6,
    position: "bottom",
    background: false,
    backgroundColor: "#000000",
    backgroundOpacity: 0.5,
  },
};

// Every preset pairs a bright fill color with a black outline (never the reverse).
// Video content is unpredictable — sometimes bright, sometimes dark — and a dark
// outline is what reliably keeps text readable against either, the way professional
// captions and top YouTube channels do it. A light outline (e.g. around dark text)
// looks fine in isolation but all but disappears over a bright frame, which is the
// same problem the red/white-outline preset had.
const SUBTITLE_COLOR_PRESETS = [
  { id: "white", label: "白", color: "#ffffff", strokeColor: "#000000" },
  { id: "yellow", label: "黄", color: "#ffe600", strokeColor: "#000000" },
  { id: "cyan", label: "水色", color: "#4de8ff", strokeColor: "#000000" },
  { id: "green", label: "緑", color: "#4dff88", strokeColor: "#000000" },
  { id: "red", label: "赤", color: "#ff6259", strokeColor: "#000000" },
];

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

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

const LONG_VIDEO_THRESHOLD_SEC = 20 * 60;
const CHUNK_DURATION_SEC = 15 * 60;

function formatMinSec(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function handleVideoFile(file, { skipSplitCheck = false } = {}) {
  if (!skipSplitCheck) {
    state.chunks = [];
    state.currentChunkIndex = null;
    el("chunk-list-wrap").hidden = true;
    el("split-suggestion").hidden = true;
  }

  state.videoFile = file;
  previewVideo.src = URL.createObjectURL(file);
  el("upload-info").textContent = "音声を解析しています…";

  setStepEnabled("step-cut", false);
  setStepEnabled("step-subtitle", false);
  setStepEnabled("step-audio", false);
  setStepEnabled("step-export", false);
  el("apply-cut-btn").disabled = true;

  const arrayBuffer = await file.arrayBuffer();
  state.analysis = await decodeToMono16k(arrayBuffer);
  el("upload-info").textContent = `読み込み完了（長さ: ${state.analysis.duration.toFixed(1)}秒）`;

  if (!skipSplitCheck && state.analysis.duration > LONG_VIDEO_THRESHOLD_SEC) {
    el("split-duration-text").textContent = formatMinSec(state.analysis.duration);
    el("split-suggestion").hidden = false;
  } else {
    setStepEnabled("step-cut", true);
  }
}

el("split-skip-btn").addEventListener("click", () => {
  el("split-suggestion").hidden = true;
  setStepEnabled("step-cut", true);
});

el("split-btn").addEventListener("click", async () => {
  const btn = el("split-btn");
  const skipBtn = el("split-skip-btn");
  btn.disabled = true;
  skipBtn.disabled = true;
  const progressWrap = el("split-progress-wrap");
  const progressFill = el("split-progress-fill");
  const progressText = el("split-progress-text");
  progressWrap.hidden = false;
  progressText.textContent = "分割しています…";

  try {
    const ffmpeg = await getFFmpeg();
    const chunks = await splitVideoIntoChunks(
      ffmpeg,
      state.videoFile,
      state.analysis.duration,
      CHUNK_DURATION_SEC,
      (progress) => {
        const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
        progressFill.style.width = `${pct}%`;
        progressText.textContent = `分割中… ${pct}%`;
      }
    );

    state.chunks = chunks.map((c, i) => ({
      start: c.start,
      end: c.end,
      file: new File([c.bytes], `part${i + 1}.mp4`, { type: "video/mp4" }),
      status: "pending",
      downloadUrl: null,
    }));
    state.currentChunkIndex = null;

    progressText.textContent = `分割完了！（${state.chunks.length}パート）`;
    el("split-suggestion").hidden = true;
    el("chunk-list-wrap").hidden = false;
    renderChunkList();
  } catch (err) {
    console.error(err);
    progressText.textContent = `エラーが発生しました: ${errorMessage(err)}`;
  } finally {
    btn.disabled = false;
    skipBtn.disabled = false;
  }
});

function renderChunkList() {
  const listEl = el("chunk-list");
  listEl.innerHTML = "";
  const statusLabels = { pending: "未処理", active: "処理中", done: "完了" };

  state.chunks.forEach((chunk, i) => {
    const row = document.createElement("div");
    row.className = "chunk-row" + (state.currentChunkIndex === i ? " active" : "");

    const label = document.createElement("span");
    label.className = "chunk-label";
    label.textContent = `パート${i + 1}（${formatMinSec(chunk.start)}〜${formatMinSec(chunk.end)}）`;

    const status = document.createElement("span");
    status.className = `chunk-status ${chunk.status}`;
    status.textContent = statusLabels[chunk.status];

    const processBtn = document.createElement("button");
    processBtn.type = "button";
    processBtn.className = "btn small";
    processBtn.textContent = "このパートを処理する";
    processBtn.addEventListener("click", () => selectChunk(i));

    row.appendChild(label);
    row.appendChild(status);
    row.appendChild(processBtn);

    if (chunk.downloadUrl) {
      const link = document.createElement("a");
      link.className = "btn small";
      link.href = chunk.downloadUrl;
      link.download = `edited-part${i + 1}.mp4`;
      link.textContent = "ダウンロード";
      row.appendChild(link);
    }

    listEl.appendChild(row);
  });
}

async function selectChunk(i) {
  state.currentChunkIndex = i;
  state.chunks[i].status = "active";
  renderChunkList();
  await handleVideoFile(state.chunks[i].file, { skipSplitCheck: true });
  el("step-cut").scrollIntoView({ behavior: "smooth", block: "start" });
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
    state.cutPointTimes = computeCutPointTimes(state.keepSegments);
    state.selectedCutPoints = new Set();
    renderCutPointList();

    const blob = new Blob([data], { type: "video/mp4" });
    previewVideo.src = URL.createObjectURL(blob);
    progressText.textContent = "カット完了！";

    setStepEnabled("step-subtitle", true);
    setStepEnabled("step-audio", true);
    setStepEnabled("step-export", true);
  } catch (err) {
    console.error(err);
    progressText.textContent = `エラーが発生しました: ${errorMessage(err)}`;
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

  const startedAt = Date.now();
  let stageText = "準備を開始しています…";
  const updateDisplay = () => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    progressText.textContent = `${stageText}（経過: ${elapsedSec}秒）`;
  };
  const tickTimer = setInterval(updateDisplay, 1000);
  updateDisplay();

  const MODEL_FALLBACK_ORDER = ["Xenova/whisper-medium", "Xenova/whisper-small", "Xenova/whisper-base"];

  function isResourceError(message) {
    return /OrtRun|memory|out of bounds|allocat/i.test(message);
  }

  try {
    const blob = new Blob([state.cutVideoBytes], { type: "video/mp4" });
    const { samples } = await decodeToMono16k(await blob.arrayBuffer());
    const requestedModelId = el("transcribe-model-select").value;

    const startIndex = MODEL_FALLBACK_ORDER.indexOf(requestedModelId);
    const modelChain = startIndex >= 0 ? MODEL_FALLBACK_ORDER.slice(startIndex) : [requestedModelId];

    let segments = null;
    let lastErr = null;
    for (let i = 0; i < modelChain.length; i++) {
      const modelId = modelChain[i];
      try {
        segments = await transcribeAudio(samples, modelId, (progress) => {
          if (progress.status === "progress" && progress.total) {
            const pct = Math.round((progress.loaded / progress.total) * 100);
            progressFill.style.width = `${pct}%`;
            stageText = `モデルをダウンロード中… ${pct}%`;
          } else if (progress.status === "initiate") {
            stageText = "モデルファイルを確認しています…";
          } else if (progress.status === "ready" || progress.status === "done") {
            progressFill.style.width = "100%";
            stageText = "文字起こし処理中です。動画の長さによっては数分かかります…";
          } else if (progress.status) {
            stageText = "準備中です…";
          }
          updateDisplay();
        });
        break;
      } catch (err) {
        lastErr = err;
        const message = errorMessage(err);
        const hasNextModel = i < modelChain.length - 1;
        if (!isResourceError(message) || !hasNextModel) throw err;
        console.warn(`transcription failed with ${modelId}, falling back to ${modelChain[i + 1]}:`, err);
        stageText = `${modelId}での処理に失敗したため、より軽いモデルに切り替えています…`;
        updateDisplay();
      }
    }

    if (!segments) throw lastErr;

    clearInterval(tickTimer);
    progressText.textContent = "文字起こし完了！";
    state.transcriptSegments = segments;
    renderTranscriptList(segments);
    el("download-vtt-btn").disabled = false;
    el("burn-subtitle-checkbox").disabled = false;
  } catch (err) {
    clearInterval(tickTimer);
    console.error(err);
    const message = errorMessage(err);
    progressText.textContent = isResourceError(message)
      ? `エラーが発生しました: ${message}（モデルが重すぎる可能性があります。精度を「標準」に下げてもう一度お試しください）`
      : `エラーが発生しました: ${message}`;
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

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applySubtitleOverlayStyle() {
  const style = state.subtitleStyle;
  const videoHeight = previewVideo.clientHeight || 300;
  const fontSizePx = Math.round(videoHeight * (style.fontSizePercent / 100));
  const strokeWidthPx = fontSizePx * style.strokeRatio;

  subtitleOverlay.style.fontSize = `${fontSizePx}px`;
  subtitleOverlay.style.fontWeight = "bold";
  subtitleOverlay.style.color = style.color;
  subtitleOverlay.style.webkitTextStroke = `${strokeWidthPx}px ${style.strokeColor}`;
  subtitleOverlay.style.textShadow =
    style.strokeRatio > 0
      ? `0 0 ${strokeWidthPx}px ${style.strokeColor}, 0 0 ${strokeWidthPx}px ${style.strokeColor}`
      : "none";

  if (style.position === "top") {
    subtitleOverlay.style.top = "6%";
    subtitleOverlay.style.bottom = "auto";
    subtitleOverlay.style.transform = "none";
  } else if (style.position === "center") {
    subtitleOverlay.style.top = "50%";
    subtitleOverlay.style.bottom = "auto";
    subtitleOverlay.style.transform = "translateY(-50%)";
  } else {
    subtitleOverlay.style.top = "auto";
    subtitleOverlay.style.bottom = "8%";
    subtitleOverlay.style.transform = "none";
  }

  const span = subtitleOverlay.querySelector("span");
  if (span) {
    span.style.backgroundColor = style.background
      ? hexToRgba(style.backgroundColor, style.backgroundOpacity)
      : "transparent";
  }
}

function renderColorPresets() {
  const wrap = el("subtitle-color-presets");
  SUBTITLE_COLOR_PRESETS.forEach((preset) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "subtitle-color-swatch";
    btn.style.backgroundColor = preset.color;
    btn.style.color = preset.strokeColor;
    btn.title = preset.label;
    btn.textContent = "字";
    btn.dataset.presetId = preset.id;
    if (preset.color === state.subtitleStyle.color) btn.classList.add("selected");
    btn.addEventListener("click", () => {
      state.subtitleStyle.color = preset.color;
      state.subtitleStyle.strokeColor = preset.strokeColor;
      el("subtitle-color").value = preset.color;
      el("subtitle-stroke-color").value = preset.strokeColor;
      wrap.querySelectorAll(".subtitle-color-swatch").forEach((el2) => el2.classList.remove("selected"));
      btn.classList.add("selected");
      applySubtitleOverlayStyle();
    });
    wrap.appendChild(btn);
  });
}
renderColorPresets();

function bindSubtitleStyleControl(id, key, parse = (v) => v) {
  const control = el(id);
  control.addEventListener("input", () => {
    state.subtitleStyle[key] = parse(control.value);
    applySubtitleOverlayStyle();
  });
}

bindSubtitleStyleControl("subtitle-color", "color");
bindSubtitleStyleControl("subtitle-stroke-color", "strokeColor");
bindSubtitleStyleControl("subtitle-stroke-width", "strokeRatio", Number);
bindSubtitleStyleControl("subtitle-font-size", "fontSizePercent", Number);
bindSubtitleStyleControl("subtitle-position", "position");
bindSubtitleStyleControl("subtitle-bg-color", "backgroundColor");
bindSubtitleStyleControl("subtitle-bg-opacity", "backgroundOpacity", Number);

el("subtitle-bg-enable").addEventListener("change", (e) => {
  state.subtitleStyle.background = e.target.checked;
  el("subtitle-bg-options").hidden = !e.target.checked;
  applySubtitleOverlayStyle();
});

window.addEventListener("resize", applySubtitleOverlayStyle);
previewVideo.addEventListener("loadedmetadata", applySubtitleOverlayStyle);
applySubtitleOverlayStyle();

previewVideo.addEventListener("timeupdate", () => {
  if (!el("show-subtitle-checkbox").checked || state.transcriptSegments.length === 0) {
    subtitleOverlay.innerHTML = "";
    return;
  }
  const t = previewVideo.currentTime;
  const active = state.transcriptSegments.find((s) => t >= s.start && t <= s.end);
  if (active) {
    subtitleOverlay.innerHTML = "<span></span>";
    subtitleOverlay.querySelector("span").textContent = active.text;
    applySubtitleOverlayStyle();
  } else {
    subtitleOverlay.innerHTML = "";
  }
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

function renderCutPointList() {
  const listEl = el("cutpoint-list");
  listEl.innerHTML = "";
  state.cutPointTimes.forEach((time, i) => {
    const row = document.createElement("div");
    row.className = "cutpoint-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedCutPoints.has(i);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedCutPoints.add(i);
      else state.selectedCutPoints.delete(i);
    });

    const label = document.createElement("span");
    label.className = "time";
    label.textContent = `カット箇所 ${i + 1}（${time.toFixed(1)}秒付近）`;

    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "btn small";
    previewBtn.textContent = "▶ プレビュー";
    previewBtn.addEventListener("click", () => {
      previewVideo.currentTime = Math.max(0, time - 1.5);
      previewVideo.play();
    });

    row.appendChild(checkbox);
    row.appendChild(label);
    row.appendChild(previewBtn);
    listEl.appendChild(row);
  });
}

el("sfx-select-all-btn").addEventListener("click", () => {
  state.cutPointTimes.forEach((_, i) => state.selectedCutPoints.add(i));
  renderCutPointList();
});
el("sfx-select-none-btn").addEventListener("click", () => {
  state.selectedCutPoints.clear();
  renderCutPointList();
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

function computeCutPointTimes(keepSegments) {
  const times = [];
  let acc = 0;
  for (let i = 0; i < keepSegments.length; i++) {
    acc += keepSegments[i].end - keepSegments[i].start;
    if (i < keepSegments.length - 1) times.push(acc);
  }
  return times;
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

    if (el("sfx-enable-checkbox").checked && state.selectedCutPoints.size > 0) {
      progressText.textContent = "効果音を生成しています…";
      const buffer = await generateSfxBuffer(sfxPresetSelect.value);
      options.sfxBytes = audioBufferToWav(buffer);
      options.sfxTimes = Array.from(state.selectedCutPoints)
        .sort((a, b) => a - b)
        .map((i) => state.cutPointTimes[i])
        .slice(0, 20);
    }

    progressText.textContent = "動画を書き出しています…";
    const ffmpeg = await getFFmpeg();
    let finalData = await mixFinalAudio(ffmpeg, state.cutVideoBytes, options, (progress) => {
      const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
      progressFill.style.width = `${pct}%`;
      progressText.textContent = `書き出し中… ${pct}%`;
    });

    if (el("burn-subtitle-checkbox").checked && state.transcriptSegments.length > 0) {
      progressText.textContent = "字幕を焼き込んでいます…（動画の長さ分、時間がかかります）";
      const mixedBlob = new Blob([finalData], { type: "video/mp4" });
      finalData = await burnSubtitles(ffmpeg, mixedBlob, state.transcriptSegments, state.subtitleStyle, (fraction) => {
        const pct = Math.min(100, Math.max(0, Math.round(fraction * 100)));
        progressFill.style.width = `${pct}%`;
        progressText.textContent = `字幕を焼き込み中… ${pct}%`;
      });
    }

    const blob = new Blob([finalData], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    el("result-video").src = url;
    const link = el("download-video-link");
    link.href = url;
    el("export-result").hidden = false;
    progressText.textContent = "書き出し完了！";

    if (state.currentChunkIndex !== null && state.chunks[state.currentChunkIndex]) {
      const chunk = state.chunks[state.currentChunkIndex];
      chunk.status = "done";
      chunk.downloadUrl = url;
      renderChunkList();
    }
  } catch (err) {
    console.error(err);
    progressText.textContent = `エラーが発生しました: ${errorMessage(err)}`;
  } finally {
    btn.disabled = false;
  }
});
