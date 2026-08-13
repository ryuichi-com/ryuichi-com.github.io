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

// ffmpeg.wasm's exec() can "succeed" while still producing a file that's structurally
// broken in ways that don't show up as a non-zero exit code or an empty file — a stream
// silently dropped during a copy, or (seen when concatenating many stream-copied
// segments) the container's own duration/timestamps ending up wildly inflated relative
// to the actual content, which manifests downstream as frozen video, missing audio, or
// both, well after the export step reported success. `-i <file>` with no output makes
// ffmpeg print the input's stream list and duration and then abort (since no output was
// given), so capturing that log output is a cheap way to check both before handing
// bytes back to a caller.
async function probeFile(ffmpeg, fileName) {
  const lines = [];
  const onLog = ({ message }) => lines.push(message);
  ffmpeg.on("log", onLog);
  try {
    await ffmpeg.exec(["-i", fileName]);
  } catch {
    // expected: ffmpeg always errors here since no output file was specified
  } finally {
    ffmpeg.off("log", onLog);
  }
  const inputStart = lines.findIndex((l) => l.includes(`from '${fileName}'`));
  const relevant = inputStart >= 0 ? lines.slice(inputStart) : lines;
  const hasVideo = relevant.some((l) => /Stream #\d+:\d+.*: Video:/.test(l));
  const durationLine = relevant.find((l) => /^\s*Duration:/.test(l));
  const durationMatch = durationLine && durationLine.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSeconds = durationMatch
    ? parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3])
    : null;
  return { hasVideo, durationSeconds };
}

async function hasVideoStream(ffmpeg, fileName) {
  return (await probeFile(ffmpeg, fileName)).hasVideo;
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
      await execChecked(ffmpeg, ["-f", "concat", "-safe", "0", "-i", "concat-list.txt", "-c", "copy", mergedName]);
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
  const expectedDuration = keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);

  let data;
  try {
    data = await cutSilenceSegmentsFast(ffmpeg, inputName, keepSegments, onProgress);
    // The stream-copy fast path can silently drop the video track on some inputs even
    // when every individual exec() call "succeeds" and produces non-empty files (see
    // extractSegmentsBatch's empty-file check above for the same failure class), so the
    // concatenated result is checked for a video stream before it's trusted. But a
    // subtler failure was also found with many-segment cuts (dozens of small kept
    // windows, as a real silence-cut on a real recording produces): concatenating that
    // many independently stream-copied segments can leave the container's own duration
    // wildly inflated relative to the actual kept audio/video (a ~40s cut reporting
    // 12+ minutes was observed) even though both streams are technically still present
    // — this is what caused reports of audio going silent or video freezing partway
    // through a downloaded export, well after the "cut complete" step reported success.
    // Comparing the result's reported duration against the sum of the kept segments'
    // durations (with slack for keyframe-snapped boundaries) catches that case too.
    await ffmpeg.writeFile("cut-verify.mp4", new Uint8Array(data));
    const { hasVideo, durationSeconds } = await probeFile(ffmpeg, "cut-verify.mp4");
    await tryDeleteFile(ffmpeg, "cut-verify.mp4");
    if (!hasVideo) {
      throw new Error("stream-copy cut result is missing its video stream");
    }
    const durationTolerance = Math.max(5, expectedDuration * 0.25);
    if (durationSeconds === null || Math.abs(durationSeconds - expectedDuration) > durationTolerance) {
      throw new Error(
        `stream-copy cut result has an implausible duration (expected ~${expectedDuration.toFixed(1)}s, got ${durationSeconds}s)`
      );
    }
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

  // Video is always copied (-c:v copy), never re-encoded, in the primary attempt below
  // — re-encoding a video track that's already fine on every export would be needlessly
  // slow. A stream copy can fail on some inputs (an incompatible codec, or an explicit
  // "-map" that doesn't resolve — e.g. "cut.mp4" unexpectedly missing a video track);
  // execChecked() turns that into a real, catchable error (ffmpeg does exit non-zero
  // for a "-map" matching nothing) instead of the exec() call being silently trusted.
  // hasVideoStream() is a second, independent check on top of that: it confirms the
  // output file itself still has a video stream rather than relying solely on the exit
  // code, in case some other stream-copy failure mode doesn't surface as a non-zero
  // exit (as seen with the empty-segment bug above, before this file's own -map fix).
  // Either check failing falls back to re-encoding the video track.
  async function runMix(videoCodecArgs) {
    if (mixParts.length === 1) {
      await execChecked(ffmpeg, ["-i", "cut.mp4", "-map", "0:v:0", "-map", "0:a:0", ...videoCodecArgs, "-c:a", "copy", "final.mp4"]);
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
        ...videoCodecArgs,
        "-c:a",
        "aac",
        "final.mp4",
      ]);
      filterChain.pop();
    }
  }

  try {
    await runMix(["-c:v", "copy"]);
    if (!(await hasVideoStream(ffmpeg, "final.mp4"))) {
      throw new Error("stream copy produced an output with no video stream");
    }
  } catch (err) {
    console.warn("stream-copy export failed, falling back to re-encode:", err);
    await tryDeleteFile(ffmpeg, "final.mp4");
    await runMix(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23"]);
  }

  return ffmpeg.readFile("final.mp4");
}
