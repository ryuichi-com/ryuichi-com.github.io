function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function greedyWrap(ctx, units, sep, limit) {
  const lines = [];
  let current = "";
  for (const unit of units) {
    const test = current ? current + sep + unit : unit;
    if (ctx.measureText(test).width > limit && current) {
      lines.push(current);
      current = unit;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapText(ctx, text, maxWidth) {
  const hasSpaces = text.includes(" ");
  const units = hasSpaces ? text.split(" ") : Array.from(text);
  const sep = hasSpaces ? " " : "";

  const initialLines = greedyWrap(ctx, units, sep, maxWidth);
  if (initialLines.length <= 1) return initialLines;

  // Greedy wrapping packs each line as full as possible before overflowing, which
  // tends to leave a very short "orphan" final line (e.g. a single trailing kana +
  // punctuation) once the rest of the text has been front-loaded. Re-wrapping at a
  // narrower width — sized so the same line count divides the text's total width
  // roughly evenly — produces visually balanced lines instead of one long line
  // followed by a near-empty one.
  const sepWidth = hasSpaces ? ctx.measureText(sep).width : 0;
  const totalWidth =
    units.reduce((sum, u) => sum + ctx.measureText(u).width, 0) + sepWidth * (units.length - 1);
  const targetWidth = Math.min(maxWidth, Math.ceil(totalWidth / initialLines.length) + sepWidth + 2);
  const balanced = greedyWrap(ctx, units, sep, targetWidth);
  return balanced.length <= initialLines.length ? balanced : initialLines;
}

export function drawSubtitleFrame(ctx, text, width, height, style) {
  if (!text) return;
  const fontSize = Math.round(height * (style.fontSizePercent / 100));
  const strokeWidth = fontSize * style.strokeRatio;
  ctx.font = `bold ${fontSize}px "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";

  const lines = wrapText(ctx, text, width * 0.88);
  const lineHeight = fontSize * 1.35;
  const totalHeight = lines.length * lineHeight;

  let startY;
  if (style.position === "top") {
    startY = fontSize + height * 0.06;
  } else if (style.position === "center") {
    startY = height / 2 - totalHeight / 2 + fontSize;
  } else {
    startY = height - totalHeight - height * 0.08 + fontSize;
  }

  lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    if (style.background) {
      const metrics = ctx.measureText(line);
      const paddingX = fontSize * 0.4;
      const paddingY = fontSize * 0.25;
      ctx.fillStyle = hexToRgba(style.backgroundColor, style.backgroundOpacity);
      ctx.fillRect(
        width / 2 - metrics.width / 2 - paddingX,
        y - fontSize * 0.85 - paddingY,
        metrics.width + paddingX * 2,
        fontSize * 1.15 + paddingY * 2
      );
    }
    if (strokeWidth > 0) {
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = style.strokeColor;
      ctx.strokeText(line, width / 2, y);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(line, width / 2, y);
  });
}

export async function burnSubtitles(ffmpeg, videoBlob, segments, style, onProgress) {
  const videoEl = document.createElement("video");
  videoEl.src = URL.createObjectURL(videoBlob);
  // Muting the element also silences the signal captured via createMediaElementSource
  // in Chromium-based browsers, not just the speaker output — so despite looking like
  // the right way to keep this hidden background element quiet, it silently produced
  // an audio-less recording. Leaving it unmuted means audio audibly plays during the
  // burn-in process, which is an acceptable trade-off for actually getting audio out.
  await new Promise((resolve, reject) => {
    videoEl.onloadedmetadata = resolve;
    videoEl.onerror = () => reject(new Error("動画の読み込みに失敗しました"));
  });

  const width = videoEl.videoWidth;
  const height = videoEl.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const audioCtx = new AudioContext();
  // Browsers create a new AudioContext in the "suspended" state unless it's started
  // within a very short window of a user gesture. Burning subtitles happens well after
  // the export button click (after audio mixing etc.), so without an explicit resume()
  // the context can stay suspended and silently produce no audio at all in the output.
  await audioCtx.resume();
  const source = audioCtx.createMediaElementSource(videoEl);
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(dest);

  const canvasStream = canvas.captureStream(30);
  const combined = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);

  const recorder = new MediaRecorder(combined, { mimeType: "video/webm;codecs=vp9,opus" });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  function activeSegment(t) {
    return segments.find((s) => t >= s.start && t <= s.end);
  }

  function drawFrame() {
    ctx.drawImage(videoEl, 0, 0, width, height);
    const seg = activeSegment(videoEl.currentTime);
    drawSubtitleFrame(ctx, seg ? seg.text : "", width, height, style);
    if (onProgress && videoEl.duration) {
      onProgress(videoEl.currentTime / videoEl.duration);
    }
  }

  // requestAnimationFrame is throttled or fully suspended by the browser as soon as the
  // tab is backgrounded (e.g. the user switches tabs while a long export runs), which
  // would freeze the recorded video on whatever frame was last drawn. Video playback
  // itself, however, keeps running in the background, so driving the draw loop from
  // requestVideoFrameCallback (tied to actual decoded video frames) keeps it going
  // regardless of tab visibility. Fall back to a timer for browsers without it.
  let framesDone = false;
  let intervalId = null;
  if (typeof videoEl.requestVideoFrameCallback === "function") {
    const onFrame = () => {
      if (framesDone) return;
      drawFrame();
      videoEl.requestVideoFrameCallback(onFrame);
    };
    videoEl.requestVideoFrameCallback(onFrame);
  } else {
    intervalId = setInterval(() => {
      if (!framesDone) drawFrame();
    }, 1000 / 30);
  }

  // When the tab is backgrounded (user switches away, minimizes the window) for a
  // stretch during a long export, Chromium throttles/suspends actual video decode for
  // the hidden page while the Web Audio graph keeps running largely unthrottled (it's
  // specifically exempted to avoid audible glitches). Left alone, that produces a
  // recording where video freezes on the last decoded frame for however long the tab
  // was hidden while audio keeps advancing underneath it — a growing desync, not just
  // a brief freeze. Explicitly pausing playback (which pauses both the video and, via
  // the media-element-sourced audio graph, its audio output) the moment the page goes
  // hidden — and resuming both together once it's visible again — keeps video and
  // audio locked in step: the output gets a clean freeze-frame pause instead of a
  // growing drift, and total wall-clock time simply stretches by however long the tab
  // was hidden.
  let backgroundPaused = false;
  function handleVisibilityChange() {
    if (document.hidden) {
      if (!videoEl.paused) {
        videoEl.pause();
        backgroundPaused = true;
      }
    } else if (backgroundPaused) {
      backgroundPaused = false;
      videoEl.play().catch(() => {});
    }
  }
  document.addEventListener("visibilitychange", handleVisibilityChange);

  try {
    recorder.start();
    videoEl.currentTime = 0;
    await videoEl.play();

    await new Promise((resolve) => {
      videoEl.onended = resolve;
    });
  } finally {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  framesDone = true;
  if (intervalId) clearInterval(intervalId);
  recorder.stop();
  await stopped;
  await audioCtx.close();

  const webmBlob = new Blob(chunks, { type: "video/webm" });
  const webmBytes = new Uint8Array(await webmBlob.arrayBuffer());

  await ffmpeg.writeFile("burned-in.webm", webmBytes);
  await ffmpeg.exec([
    "-i",
    "burned-in.webm",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "burned-in.mp4",
  ]);
  return ffmpeg.readFile("burned-in.mp4");
}
