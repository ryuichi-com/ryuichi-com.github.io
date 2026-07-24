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
  await ffmpeg.exec(args);
  return segmentNames;
}

// Extracts each kept segment with stream copy (no decode/encode, just a fast
// keyframe-aligned cut) and joins them with the concat demuxer, which is also stream
// copy. This only works when the source codecs are compatible with an mp4 container
// (true for the vast majority of uploads: phone/screen recordings in H.264+AAC).
async function cutSilenceSegmentsFast(ffmpeg, inputName, keepSegments, onProgress, batchSize = 20) {
  const outputName = "cut.mp4";
  const segmentNames = [];
  try {
    for (let i = 0; i < keepSegments.length; i += batchSize) {
      const batch = keepSegments.slice(i, i + batchSize);
      const batchNames = await extractSegmentsBatch(ffmpeg, inputName, batch, i);
      segmentNames.push(...batchNames);
      if (onProgress) onProgress((Math.min(i + batchSize, keepSegments.length) / (keepSegments.length + 1)) * 0.8);
    }

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
  const inputName = await mountInputFile(ffmpeg, videoFile);

  let data;
  try {
    data = await cutSilenceSegmentsFast(ffmpeg, inputName, keepSegments, onProgress);
  } catch (err) {
    console.warn("stream-copy cut failed, falling back to re-encode:", err);
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
