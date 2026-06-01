chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "playSound") return;
  playChime(msg.sound);
});

function playNote(ctx, freq, start, dur, peak = 1.0) {
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  // Sawtooth + a sub-octave and detuned voices: richer harmonics read as
  // much louder than a sine/triangle at the same gain.
  [
    { type: "sawtooth", freq, detune: 0 },
    { type: "sawtooth", freq, detune: 6 },
    { type: "square", freq: freq / 2, detune: 0 },
  ].forEach(({ type, freq: f, detune }) => {
    const osc = ctx.createOscillator();
    osc.connect(gain);
    osc.type = type;
    osc.frequency.value = f;
    osc.detune.value = detune;
    osc.start(start);
    osc.stop(start + dur + 0.05);
  });
}

function playChime(sound) {
  const ctx = new AudioContext();
  const now = ctx.currentTime;

  // Ascending = back to work, descending = break time.
  const tones = sound === "break"
    ? [988, 740, 988, 740, 587]   // descending ring
    : [587, 740, 988, 740, 988];  // ascending ring

  let t = now;
  tones.forEach((freq, i) => {
    const dur = i === tones.length - 1 ? 0.5 : 0.22;
    playNote(ctx, freq, t, dur, 1.0);
    t += 0.2;
  });

  const totalMs = (t - now + 0.6) * 1000;
  setTimeout(() => ctx.close().catch(() => {}), totalMs);
}
