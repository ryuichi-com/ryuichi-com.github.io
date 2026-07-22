export function computeRmsWindows(samples, sampleRate, windowSeconds = 0.05) {
  const windowSize = Math.max(1, Math.round(sampleRate * windowSeconds));
  const windowCount = Math.ceil(samples.length / windowSize);
  const dbLevels = new Float32Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    dbLevels[w] = 20 * Math.log10(rms + 1e-9);
  }
  return { dbLevels, windowSize };
}

export function detectSilenceKeepSegments(samples, sampleRate, options = {}) {
  const {
    thresholdDb = -40,
    minSilenceSeconds = 0.6,
    paddingSeconds = 0.15,
  } = options;

  const totalDuration = samples.length / sampleRate;
  const { dbLevels, windowSize } = computeRmsWindows(samples, sampleRate);
  const windowSeconds = windowSize / sampleRate;
  const minSilenceWindows = Math.max(1, Math.round(minSilenceSeconds / windowSeconds));

  const silentRanges = [];
  let runStart = -1;
  for (let w = 0; w <= dbLevels.length; w++) {
    const isSilent = w < dbLevels.length && dbLevels[w] < thresholdDb;
    if (isSilent && runStart === -1) {
      runStart = w;
    } else if (!isSilent && runStart !== -1) {
      const runLength = w - runStart;
      if (runLength >= minSilenceWindows) {
        silentRanges.push({
          start: runStart * windowSeconds,
          end: Math.min(totalDuration, w * windowSeconds),
        });
      }
      runStart = -1;
    }
  }

  if (silentRanges.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  const keepRanges = [];
  let cursor = 0;
  for (const silence of silentRanges) {
    if (silence.start > cursor) {
      keepRanges.push({ start: cursor, end: silence.start });
    }
    cursor = silence.end;
  }
  if (cursor < totalDuration) {
    keepRanges.push({ start: cursor, end: totalDuration });
  }

  const padded = keepRanges.map((range) => ({
    start: Math.max(0, range.start - paddingSeconds),
    end: Math.min(totalDuration, range.end + paddingSeconds),
  }));

  const merged = [];
  for (const range of padded) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged.length > 0 ? merged : [{ start: 0, end: totalDuration }];
}

export function totalKeepDuration(keepSegments) {
  return keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
}

export function computeWaveformPeaks(samples, bucketCount) {
  const peaks = new Float32Array(bucketCount);
  const bucketSize = Math.max(1, Math.floor(samples.length / bucketCount));
  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}
