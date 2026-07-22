const NOTE_FREQ = {
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0,
};

export const BGM_PRESETS = [
  {
    id: "calm-pad",
    label: "穏やかなパッド",
    description: "ゆったりした和音が続く、落ち着いたBGM",
    tempo: 70,
    chords: [
      ["C4", "E4", "G4"],
      ["A3", "C4", "E4"],
      ["F3", "A3", "C4"],
      ["G3", "B3", "D4"],
    ],
    wave: "sine",
  },
  {
    id: "lofi-chill",
    label: "Lo-fi Chill",
    description: "少しゆらぎのある、まったりした雰囲気",
    tempo: 80,
    chords: [
      ["A3", "C4", "E4"],
      ["F3", "A3", "C4"],
      ["D3", "F3", "A3"],
      ["G3", "B3", "D4"],
    ],
    wave: "triangle",
  },
  {
    id: "upbeat-pluck",
    label: "アップビート",
    description: "軽快でポップな明るいBGM",
    tempo: 120,
    chords: [
      ["C4", "E4", "G4"],
      ["G3", "B3", "D4"],
      ["A3", "C4", "E4"],
      ["F3", "A3", "C4"],
    ],
    wave: "square",
  },
  {
    id: "corporate-bright",
    label: "コーポレート",
    description: "説明・解説動画向けの前向きなBGM",
    tempo: 100,
    chords: [
      ["F3", "A3", "C4"],
      ["C4", "E4", "G4"],
      ["D3", "F3", "A3"],
      ["G3", "B3", "D4"],
    ],
    wave: "sine",
  },
];

export const SFX_PRESETS = [
  { id: "pop", label: "ポン" },
  { id: "whoosh", label: "シュッ" },
  { id: "ding", label: "ピンポン" },
  { id: "click", label: "カチッ" },
];

function createOfflineContext(durationSeconds, sampleRate = 44100) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const length = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  return new OfflineCtx(2, length, sampleRate);
}

export async function generateBgmBuffer(presetId, durationSeconds) {
  const preset = BGM_PRESETS.find((p) => p.id === presetId) || BGM_PRESETS[0];
  const ctx = createOfflineContext(durationSeconds);
  const beatSeconds = 60 / preset.tempo;
  const chordSeconds = beatSeconds * 4;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = preset.wave === "square" ? 2200 : 3000;
  filter.connect(master);

  let t = 0;
  let chordIndex = 0;
  while (t < durationSeconds) {
    const chord = preset.chords[chordIndex % preset.chords.length];
    for (const noteName of chord) {
      const freq = NOTE_FREQ[noteName];
      if (!freq) continue;
      const osc = ctx.createOscillator();
      osc.type = preset.wave;
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const attack = 0.05;
      const release = chordSeconds * 0.5;
      const peak = 0.18;
      gain.gain.setValueAtTime(0, ctx.currentTime + t);
      gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + t + attack);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + attack + release);
      osc.connect(gain);
      gain.connect(filter);
      osc.start(t);
      osc.stop(Math.min(durationSeconds, t + attack + release + 0.05));
    }
    t += chordSeconds;
    chordIndex += 1;
  }

  return ctx.startRendering();
}

export async function generateSfxBuffer(presetId) {
  const durations = { pop: 0.18, whoosh: 0.35, ding: 0.6, click: 0.08 };
  const duration = durations[presetId] || 0.3;
  const ctx = createOfflineContext(duration);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  if (presetId === "pop") {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, 0);
    osc.frequency.exponentialRampToValueAtTime(220, duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6, 0);
    gain.gain.exponentialRampToValueAtTime(0.001, duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(0);
    osc.stop(duration);
  } else if (presetId === "whoosh") {
    const bufferSize = Math.ceil(ctx.sampleRate * duration);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(400, 0);
    filter.frequency.linearRampToValueAtTime(3000, duration);
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, 0);
    gain.gain.linearRampToValueAtTime(0.5, duration * 0.4);
    gain.gain.exponentialRampToValueAtTime(0.001, duration);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    noise.start(0);
  } else if (presetId === "ding") {
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.5 / (i + 1), 0);
      gain.gain.exponentialRampToValueAtTime(0.001, duration);
      osc.connect(gain);
      gain.connect(master);
      osc.start(0);
      osc.stop(duration);
    });
  } else {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 1200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.4, 0);
    gain.gain.exponentialRampToValueAtTime(0.001, duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(0);
    osc.stop(duration);
  }

  return ctx.startRendering();
}

export function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const bufferSize = 44 + dataSize;
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Uint8Array(arrayBuffer);
}
