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

export async function cutSilenceSegments(ffmpeg, videoFile, keepSegments, onProgress) {
  const inputExt = extensionFromFile(videoFile);
  const inputName = `input.${inputExt}`;
  const outputName = "cut.mp4";

  const buf = new Uint8Array(await videoFile.arrayBuffer());
  await ffmpeg.writeFile(inputName, buf);

  if (onProgress) ffmpeg.on("progress", ({ progress }) => onProgress(progress));

  const filterParts = [];
  const concatLabels = [];
  keepSegments.forEach((seg, i) => {
    filterParts.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`
    );
    filterParts.push(
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
    );
    concatLabels.push(`[v${i}][a${i}]`);
  });
  filterParts.push(
    `${concatLabels.join("")}concat=n=${keepSegments.length}:v=1:a=1[outv][outa]`
  );
  const filterComplex = filterParts.join(";");

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

  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName);
  return data;
}

export async function mixFinalAudio(ffmpeg, cutVideoBytes, options, onProgress) {
  const { bgmBytes, bgmExt = "wav", bgmVolume = 0.2, sfxBytes, sfxTimes = [], durationSeconds } = options;

  await ffmpeg.writeFile("cut.mp4", cutVideoBytes);

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
