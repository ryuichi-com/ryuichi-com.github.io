function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function wrapText(ctx, text, maxWidth) {
  const hasSpaces = text.includes(" ");
  const units = hasSpaces ? text.split(" ") : Array.from(text);
  const sep = hasSpaces ? " " : "";
  const lines = [];
  let current = "";
  for (const unit of units) {
    const test = current ? current + sep + unit : unit;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = unit;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function drawSubtitleFrame(ctx, text, width, height, style) {
  if (!text) return;
  const fontSize = style.fontSize;
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
    if (style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth;
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
  videoEl.muted = true;
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

  let rafId = null;
  function drawLoop() {
    ctx.drawImage(videoEl, 0, 0, width, height);
    const seg = activeSegment(videoEl.currentTime);
    drawSubtitleFrame(ctx, seg ? seg.text : "", width, height, style);
    if (onProgress && videoEl.duration) {
      onProgress(videoEl.currentTime / videoEl.duration);
    }
    if (!videoEl.paused && !videoEl.ended) {
      rafId = requestAnimationFrame(drawLoop);
    }
  }

  recorder.start();
  videoEl.currentTime = 0;
  await videoEl.play();
  drawLoop();

  await new Promise((resolve) => {
    videoEl.onended = resolve;
  });
  if (rafId) cancelAnimationFrame(rafId);
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
