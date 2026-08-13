const CORE_VERSION = "0.12.6";
const FFMPEG_VERSION = "0.12.10";
const UTIL_VERSION = "0.12.1";

let ffmpegInstance = null;
let loadPromise = null;

export async function getFFmpeg(onLog) {
  if (ffmpegInstance) return ffmpegInstance;
  if (!loadPromise) {
    loadPromise = (async () => {
      const { FFmpeg } = await import(
        `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/index.js`
      );
      const { toBlobURL } = await import(
        `https://cdn.jsdelivr.net/npm/@ffmpeg/util@${UTIL_VERSION}/dist/esm/index.js`
      );
      const ffmpeg = new FFmpeg();
      if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));
      const base = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
      // The ESM worker.js has relative imports ("./const.js" etc.) that only resolve when
      // served from its real path, but a Worker constructed with a cross-origin URL is
      // blocked by the browser. The UMD worker chunk is a single self-contained file with
      // no relative imports, so it can safely be loaded as a same-origin blob: URL instead.
      const workerChunkURL = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/umd/814.ffmpeg.js`;
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
        classWorkerURL: await toBlobURL(workerChunkURL, "text/javascript"),
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })();
  }
  return loadPromise;
}

async function tryDeleteFile(ffmpeg, name) {
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    // ignore, file may not exist
  }
}

// ffmpeg.exec() does NOT throw/reject when the ffmpeg command itself fails (an
// incompatible stream copy, an invalid -map, etc.) — per @ffmpeg/ffmpeg's own type
// signature it resolves with a plain exit code, 0 for success and non-zero for any
// error, and every call site in this file used to just await it and assume success.
// That's the actual root cause behind more than one "ffmpeg silently produced a broken
// file" bug found in this pipeline (an empty segment, a video track quietly dropped by
// a "-map" that didn't match anything) — the failures were never silent at the ffmpeg
// level, just never checked. Every exec() that must succeed for the pipeline to be
// correct should go through this wrapper instead of calling ffmpeg.exec() directly.
async function execChecked(ffmpeg, args) {
  const code = await ffmpeg.exec(args);
  if (code !== 0) {
    throw new Error(`ffmpegコマンドが失敗しました（終了コード ${code}）: ${args.join(" ")}`);
  }
  return code;
}

const INPUT_MOUNT_DIR = "/input_mount";

// Writing the whole source file into ffmpeg's regular (in-memory) filesystem means its
// entire byte size sits in the WASM heap for as long as it's needed. For a long video
// (hundreds of MB) that alone can exhaust the heap and crash with "memory access out of
// bounds" before any segment work even finishes. Mounting it as a WORKERFS instead lets
// ffmpeg read directly from the browser's File object on demand (via lazy Blob reads),
// so only the parts actually being read at any moment need to be resident.
async function mountInputFile(ffmpeg, videoFile) {
  try {
    await ffmpeg.createDir(INPUT_MOUNT_DIR);
  } catch {
    // directory may already exist from a previous run in this session
  }
  await ffmpeg.mount("WORKERFS", { files: [videoFile] }, INPUT_MOUNT_DIR);
  return `${INPUT_MOUNT_DIR}/${videoFile.name}`;
}

async function unmountInputFile(ffmpeg) {
  try {
    await ffmpeg.unmount(INPUT_MOUNT_DIR);
  } catch {
    // ignore, may not be mounted
  }
}

// WASM linear memory can only grow, never shrink, for as long as a module instance is
// alive — so running one ffmpeg.exec() call per segment (hundreds of them, for a long
// video with many cuts) keeps ratcheting up real memory use across calls even though
// each individual extraction is cheap, eventually hitting the module's hard memory
// ceiling ("memory access out of bounds") partway through. Opening the input once and
// extracting many segments as multiple outputs of a single ffmpeg invocation avoids
// that: it costs one process lifecycle instead of dozens, so memory bounds are governed
// by the batch's own peak needs rather than an ever-climbing high-water mark. Segments
// are still extracted in batches (not all at once) so progress can be reported and a
// single bad batch doesn't block the rest.
async function extractSegmentsBatch(ffmpeg, inputName, segments, startIndex) {
  const args = ["-i", inputName];
  const segmentNames = [];
  segments.forEach((seg, offset) => {
    const segName = `seg${startIndex + offset}.mp4`;
    args.push(
      "-ss",
      String(seg.start),
      "-to",
      String(seg.end),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      segName
    );
    segmentNames.push(segName);
  });
  await execChecked(ffmpeg, args);

  // ffmpeg.exec() does not reject when a stream-copy mux is incompatible (e.g. muxing
  // VP8 into an mp4 container) — it can exit "successfully" having written empty
  // (0-byte) output files instead of throwing. Concatenating those later usually
  // surfaces the problem, but not always (e.g. a lone segment in the last batch just
  // passes straight through with no concat step to notice), so every segment's size is
  // checked explicitly here to make sure callers' fallback logic actually triggers
  // instead of silently shipping broken/empty video files.
  for (const name of segmentNames) {
    const data = await ffmpeg.readFile(name);
    const size = data.byteLength ?? data.length;
    if (!size) {
      for (const n of segmentNames) await tryDeleteFile(ffmpeg, n);
      throw new Error(`stream copy produced an empty file for ${name} (likely an incompatible codec/container)`);
    }
  }

  return segmentNames;
}

// Re-encodes every kept segment in a single filter_complex pass (trim+concat) rather
// than stream-copying and concat-demuxing separately extracted segment files. Stream
// copying many independently-cut segments together turned out not to be safe: testing
// found the concat demuxer's output can end up with a container duration wildly
// inflated relative to the actual kept content (a real ~40s cut reporting 12+ minutes,
// and the same kind of drift on cuts as small as two segments) even though ffmpeg
// reports success and both streams are technically present. Downstream players and this
// app's own subtitle burn-in step trust that duration, so the video appears to freeze or
// lose audio partway through — exactly the freezing/silent-audio reports this was
// switched to fix. Re-encoding through one filter_complex pass keeps timestamps
// (setpts=PTS-STARTPTS per segment, then a single concat) consistent by construction,
// so there's no separate "fast path" left to fall back from — this is the only path.
async function cutSilenceSegmentsReencode(ffmpeg, inputName, keepSegments, onProgress) {
  const outputName = "cut.mp4";
  const filterParts = [];
  const concatLabels = [];
  keepSegments.forEach((seg, i) => {
    filterParts.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`);
    filterParts.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
    concatLabels.push(`[v${i}][a${i}]`);
  });
  filterParts.push(`${concatLabels.join("")}concat=n=${keepSegments.length}:v=1:a=1[outv][outa]`);
  const filterComplex = filterParts.join(";");

  if (onProgress) ffmpeg.on("progress", ({ progress }) => onProgress(progress));

  await execChecked(ffmpeg, [
    "-i",
    inputName,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    outputName,
  ]);

  return ffmpeg.readFile(outputName);
}

// Splits a long source video into fixed-length chunk files (stream copy, same
// batched-multi-output approach as the silence cut above) so each chunk can go through
// the rest of the pipeline (silence cut, transcription, subtitle burn-in) independently,
// keeping every operation's memory and processing time bounded regardless of how long
// the original upload is.
export async function splitVideoIntoChunks(ffmpeg, videoFile, totalDurationSec, chunkDurationSec, onProgress) {
  const inputName = await mountInputFile(ffmpeg, videoFile);
  const boundaries = [];
  for (let t = 0; t < totalDurationSec; t += chunkDurationSec) {
    boundaries.push({ start: t, end: Math.min(totalDurationSec, t + chunkDurationSec) });
  }

  const chunkBytesList = new Array(boundaries.length);
  try {
    const batchSize = 10;
    for (let i = 0; i < boundaries.length; i += batchSize) {
      const batch = boundaries.slice(i, i + batchSize);
      let names;
      try {
        names = await extractSegmentsBatch(ffmpeg, inputName, batch, i);
      } catch (err) {
        console.warn("batched split failed, falling back to one-by-one re-encode:", err);
        names = [];
        for (let offset = 0; offset < batch.length; offset++) {
          const seg = batch[offset];
          const name = `seg${i + offset}.mp4`;
          await execChecked(ffmpeg, [
            "-i",
            inputName,
            "-ss",
            String(seg.start),
            "-to",
            String(seg.end),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            name,
          ]);
          names.push(name);
        }
      }
      for (let offset = 0; offset < names.length; offset++) {
        chunkBytesList[i + offset] = await ffmpeg.readFile(names[offset]);
        await tryDeleteFile(ffmpeg, names[offset]);
      }
      if (onProgress) onProgress(Math.min(i + batchSize, boundaries.length) / boundaries.length);
    }
  } finally {
    await unmountInputFile(ffmpeg);
  }

  return boundaries.map((b, i) => ({ start: b.start, end: b.end, bytes: chunkBytesList[i] }));
}

export async function cutSilenceSegments(ffmpeg, videoFile, keepSegments, onProgress) {
  const inputName = await mountInputFile(ffmpeg, videoFile);

  let data;
  try {
    data = await cutSilenceSegmentsReencode(ffmpeg, inputName, keepSegments, onProgress);
  } finally {
    await unmountInputFile(ffmpeg);
  }

  return data;
}

export async function mixFinalAudio(ffmpeg, cutVideoBytes, options, onProgress) {
  const { bgmBytes, bgmExt = "wav", bgmVolume = 0.2, sfxBytes, sfxTimes = [], durationSeconds } = options;

  // ffmpeg.writeFile() detaches the underlying ArrayBuffer of whatever is passed to it.
  // cutVideoBytes is held onto by the caller across possibly several export attempts
  // (e.g. re-exporting after changing BGM), so it must be copied rather than written
  // directly, or the second attempt would fail with a DataCloneError.
  await ffmpeg.writeFile("cut.mp4", new Uint8Array(cutVideoBytes));

  const inputs = ["-i", "cut.mp4"];
  let nextInputIndex = 1;
  let bgmIndex = -1;
  let sfxIndex = -1;

  if (bgmBytes) {
    const bgmName = `bgm.${bgmExt}`;
    await ffmpeg.writeFile(bgmName, bgmBytes);
    inputs.push("-stream_loop", "-1", "-i", bgmName);
    bgmIndex = nextInputIndex;
    nextInputIndex += 1;
  }

  if (sfxBytes && sfxTimes.length > 0) {
    await ffmpeg.writeFile("sfx.wav", sfxBytes);
    inputs.push("-i", "sfx.wav");
    sfxIndex = nextInputIndex;
    nextInputIndex += 1;
  }

  if (onProgress) ffmpeg.on("progress", ({ progress }) => onProgress(progress));

  const mixParts = ["[0:a]"];
  const filterChain = [];

  if (bgmIndex >= 0) {
    filterChain.push(
      `[${bgmIndex}:a]atrim=start=0:end=${durationSeconds},asetpts=PTS-STARTPTS,volume=${bgmVolume}[bgm]`
    );
    mixParts.push("[bgm]");
  }

  if (sfxIndex >= 0) {
    const cappedTimes = sfxTimes.slice(0, 20);
    const splitLabels = cappedTimes.map((_, i) => `[sfxs${i}]`).join("");
    filterChain.push(`[${sfxIndex}:a]asplit=${cappedTimes.length}${splitLabels}`);
    cappedTimes.forEach((time, i) => {
      const ms = Math.max(0, Math.round(time * 1000));
      filterChain.push(`[sfxs${i}]adelay=${ms}|${ms}[sfxd${i}]`);
      mixParts.push(`[sfxd${i}]`);
    });
  }

  // Video is always re-encoded here rather than stream-copied. A "-c:v copy" attempt
  // was tried first for a while (cheaper when it works), with a re-encode fallback on
  // failure — but stream-copy failures in this pipeline turned out not to be reliably
  // detectable (a "-map" that silently resolves to nothing, or a technically-valid copy
  // whose container ends up with corrupted duration/timestamps) even with exit-code
  // checks and post-hoc stream/duration validation. Re-encoding by construction can't
  // have those failure modes, so it's used unconditionally instead of being a fallback
  // for a fast path that isn't trustworthy.
  if (mixParts.length === 1) {
    await execChecked(ffmpeg, [
      "-i", "cut.mp4",
      "-map", "0:v:0",
      "-map", "0:a:0",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-c:a", "aac",
      "final.mp4",
    ]);
  } else {
    filterChain.push(`${mixParts.join("")}amix=inputs=${mixParts.length}:duration=first:dropout_transition=0[outa]`);
    const filterComplex = filterChain.join(";");
    await execChecked(ffmpeg, [
      ...inputs,
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "final.mp4",
    ]);
  }

  return ffmpeg.readFile("final.mp4");
}
