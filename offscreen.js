chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "playSound") return;
  playChime(msg.sound);
});

// One soft bell tone: a fundamental sine plus a quieter octave for body,
// with a quick attack and a smooth decay. Kept well under unity gain so the
// notes never clip — clipping is what made the old chime sound harsh/"off".
function playNote(ctx, master, freq, start, dur) {
  const env = ctx.createGain();
  env.connect(master);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(0.6, start + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  [{ f: freq, g: 1.0 }, { f: freq * 2, g: 0.3 }].forEach(({ f, g }) => {
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    og.gain.value = g;
    osc.type = "sine";
    osc.frequency.value = f;
    osc.connect(og); og.connect(env);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  });
}

function playChime(sound) {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.45; // master headroom — prevents summed notes clipping
  master.connect(ctx.destination);

  const now = ctx.currentTime + 0.04;

  // Ascending = back to work, descending = break time.
  const tones = sound === "break"
    ? [880, 660, 440]
    : [440, 660, 880];

  let t = now;
  tones.forEach((freq, i) => {
    const dur = i === tones.length - 1 ? 0.6 : 0.28;
    playNote(ctx, master, freq, t, dur);
    t += 0.26;
  });

  const totalMs = (t - now + 0.7) * 1000;
  setTimeout(() => ctx.close().catch(() => {}), totalMs);
}
