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

function extensionFromFile(file) {
  const name = file.name || "";
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "mp4";
}

async function tryDeleteFile(ffmpeg, name) {
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    // ignore, file may not exist
  }
}

// Joins many small mp4 files with the concat demuxer (stream copy). Merging is done in
// batches and each batch's inputs are deleted as soon as they're folded into an
// intermediate file, so at most `batchSize` segment files are ever resident in ffmpeg's
// in-memory filesystem at once — holding all of them (potentially hundreds of MB for a
// long video) until one final concat call risks exhausting the WASM heap.
async function concatFilesInBatches(ffmpeg, fileNames, outputName, batchSize = 16) {
  let currentNames = fileNames;
  let round = 0;
  while (currentNames.length > 1) {
    const nextNames = [];
    for (let i = 0; i < currentNames.length; i += batchSize) {
      const batch = currentNames.slice(i, i + batchSize);
      if (batch.length === 1) {
        nextNames.push(batch[0]);
        continue;
      }
      const mergedName = `merge-r${round}-${i}.mp4`;
      const listContent = batch.map((name) => `file '${name}'`).join("\n");
      await ffmpeg.writeFile("concat-list.txt", listContent);
      await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "concat-list.txt", "-c", "copy", mergedName]);
      for (const name of batch) await tryDeleteFile(ffmpeg, name);
      nextNames.push(mergedName);
    }
    currentNames = nextNames;
    round += 1;
  }
  await tryDeleteFile(ffmpeg, "concat-list.txt");

  const [finalName] = currentNames;
  if (finalName !== outputName) {
    const data = await ffmpeg.readFile(finalName);
    await ffmpeg.writeFile(outputName, data);
    await tryDeleteFile(ffmpeg, finalName);
  }
}

// Extracts each kept segment with stream copy (no decode/encode, just a fast
// keyframe-aligned cut) and joins them with the concat demuxer, which is also stream
// copy. This only works when the source codecs are compatible with an mp4 container
// (true for the vast majority of uploads: phone/screen recordings in H.264+AAC).
async function cutSilenceSegmentsFast(ffmpeg, inputName, keepSegments, onProgress) {
  const outputName = "cut.mp4";
  const segmentNames = [];
  try {
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      const segName = `seg${i}.mp4`;
      await ffmpeg.exec([
        "-ss",
        String(seg.start),
        "-to",
        String(seg.end),
        "-i",
        inputName,
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        segName,
      ]);
      segmentNames.push(segName);
      if (onProgress) onProgress(((i + 1) / (keepSegments.length + 1)) * 0.8);
    }

    // Free the (potentially very large) source file before assembling the output —
    // it's not needed anymore, and holding it alongside every segment file is the
    // single biggest avoidable chunk of peak memory use.
    await tryDeleteFile(ffmpeg, inputName);

    await concatFilesInBatches(ffmpeg, segmentNames, outputName);
    if (onProgress) onProgress(1);

    return await ffmpeg.readFile(outputName);
  } finally {
    await tryDeleteFile(ffmpeg, "concat-list.txt");
    for (const name of segmentNames) await tryDeleteFile(ffmpeg, name);
  }
}

// Fallback for sources whose codec isn't compatible with stream-copying into mp4
// (e.g. VP8/Opus webm uploads). Re-encodes the whole kept duration in one pass, which
// is correct for any input but much slower for long videos with many cut segments.
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

  await ffmpeg.exec([
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

export async function cutSilenceSegments(ffmpeg, videoFile, keepSegments, onProgress) {
  const inputExt = extensionFromFile(videoFile);
  const inputName = `input.${inputExt}`;

  // ffmpeg.writeFile() transfers the underlying ArrayBuffer to the worker (it becomes
  // detached afterwards), so a fresh Uint8Array has to be read for each write — the one
  // passed to the first writeFile() call below cannot be reused for the fallback path.
  await ffmpeg.writeFile(inputName, new Uint8Array(await videoFile.arrayBuffer()));

  let data;
  try {
    data = await cutSilenceSegmentsFast(ffmpeg, inputName, keepSegments, onProgress);
  } catch (err) {
    console.warn("stream-copy cut failed, falling back to re-encode:", err);
    // The fast path may have already deleted the input file (to free memory) before
    // failing later on, so re-write it.
    await tryDeleteFile(ffmpeg, inputName);
    await ffmpeg.writeFile(inputName, new Uint8Array(await videoFile.arrayBuffer()));
    data = await cutSilenceSegmentsReencode(ffmpeg, inputName, keepSegments, onProgress);
  }

  await tryDeleteFile(ffmpeg, inputName);
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

  if (mixParts.length === 1) {
    await ffmpeg.exec(["-i", "cut.mp4", "-c", "copy", "final.mp4"]);
  } else {
    filterChain.push(`${mixParts.join("")}amix=inputs=${mixParts.length}:duration=first:dropout_transition=0[outa]`);
    const filterComplex = filterChain.join(";");
    await ffmpeg.exec([
      ...inputs,
      "-filter_complex",
      filterComplex,
      "-map",
      "0:v",
      "-map",
      "[outa]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "final.mp4",
    ]);
  }

  const data = await ffmpeg.readFile("final.mp4");
  return data;
}
