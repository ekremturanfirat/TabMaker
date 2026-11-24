// Dev bench: does the tab sound like the song? Run it before and after every change to the tab engine.
//   1. copy a few songs into public/_bench/ (gitignored): data/cache/<id>/audio.m4a -> public/_bench/<name>.m4a,
//      and optionally `python tools/make_fingerstyle_audio.py public/_bench/finger.wav public/_bench/finger.json`
//   2. npm run build, start server.py, open the page, then in the dev console:
//        const B = await import('/_bench/bench.js')   // copy tools/bench.js to public/_bench/ too
//        await B.run(['golden', 'careless'])  // compare() per song (first 60 s), plus the mean
//   The model's output for each song is cached in IndexedDB, so only the tab is listened to again.
//   Other helpers: diag() (grid error), stages() (where song notes get lost), removed() / jumpsByRule()
//   (what the clean-up drops and why), truth() (against finger.json's known notes), oracle() (the score's ceiling with this synth),
//   meters({name: '6/8', ...}) / meterWhy() (time signature found vs expected, and what decided it;
//   `python tools/make_meter_audio.py public/_bench` makes test songs with known meters and meters.json; use '?'
//   for songs whose meter you don't know), meter(), pushes() (notes the rhythm grid moved audibly).
const tm = window.tabmaker;
const S = tm.state;
const RATE = 22050;
const FPS = RATE / 256;

function db() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open('tabbench', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('out');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
async function idb(op, key, val) {
  const d = await db();
  return new Promise((ok, bad) => {
    const tx = d.transaction('out', op === 'get' ? 'readonly' : 'readwrite');
    const r = op === 'get' ? tx.objectStore('out').get(key) : tx.objectStore('out').put(val, key);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
const flat = (rows) => {
  const w = rows[0].length;
  const a = new Float32Array(rows.length * w);
  rows.forEach((r, i) => a.set(r, i * w));
  return { w, a };
};
const unflat = ({ w, a }) => Array.from({ length: a.length / w }, (_, i) => Array.from(a.subarray(i * w, (i + 1) * w)));

export async function load(name, from = 0, to = 60) {
  let res = await fetch(`_bench/${name}.m4a`);
  if (!res.ok) res = await fetch(`_bench/${name}.wav`); // test songs from tools/make_*_audio.py
  const blob = await res.blob();
  const ctx = new AudioContext();
  S.decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  S.blob = blob;
  S.title = name;
  document.getElementById('audio').src = URL.createObjectURL(blob);
  document.getElementById('songTitle').textContent = name;
  document.getElementById('from').value = from;
  document.getElementById('to').value = to;
  const key = `${name}|${from}|${to}`;
  const c = await idb('get', key);
  S.tab = null;
  S.compare = null;
  if (c) {
    S.output = { frames: unflat(c.frames), onsets: unflat(c.onsets), contours: unflat(c.contours), samples: c.samples };
    S.segStart = from;
    document.getElementById('result').hidden = false;
    tm.retab();
  } else {
    await tm.listen();
    const o = S.output;
    await idb('put', key, { frames: flat(o.frames), onsets: flat(o.onsets), contours: flat(o.contours), samples: o.samples });
  }
  return document.getElementById('meta').textContent;
}

export const SONGS = ['golden', 'careless', 'army', 'nem', 'duvet', 'letgo'];

export async function run(names = SONGS, setup) {
  const rows = {};
  for (const n of names) {
    const meta = await load(n);
    if (setup) {
      setup();
      tm.retab();
    }
    const r = await tm.compare();
    rows[n] = { score: r.score, recall: r.recall, precision: r.precision, wrongTime: r.wrongTime, songNotes: r.songNotes, tabNotes: r.tabNotes, meta };
    window.__bench = { rows, done: false };
  }
  const mean = (k) => +(names.reduce((a, n) => a + rows[n][k], 0) / names.length).toFixed(3);
  window.__bench = { rows, mean: { score: mean('score'), recall: mean('recall'), precision: mean('precision') }, done: true };
  return window.__bench;
}

/** Ceiling: play the song's own heard notes with the tab synth (triangle) and score that. */
export async function oracle(name, wave = 'triangle') {
  await load(name);
  const o = S.output;
  const raw = tm.lib.outputToNotesPoly(o.frames, o.onsets, 0.5, 0.3, Math.round(0.1 * FPS), true);
  const notes = tm.lib.noteFramesToTime(raw);
  const off = new OfflineAudioContext(1, o.samples.length, RATE);
  for (const n of notes) {
    const t = n.startTimeSeconds;
    const osc = off.createOscillator();
    const g = off.createGain();
    osc.type = wave;
    osc.frequency.value = 440 * 2 ** ((n.pitchMidi - 69) / 12);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.6, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    osc.connect(g).connect(off.destination);
    osc.start(t);
    osc.stop(t + 1.25);
  }
  const buf = await off.startRendering();
  const ch = buf.getChannelData(0);
  const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const k = peak(o.samples) / peak(ch);
  for (let i = 0; i < ch.length; i++) ch[i] *= k;
  const heard = await tm.runModel(buf, () => {});
  const song = tm.heardNotes(o, 0, 40, 88);
  const mine = tm.heardNotes(heard, 0, 40, 88);
  const a = tm.matched(song, mine).hits.size;
  const b = tm.matched(mine, song).hits.size;
  return { score: +((a + b) / (song.length + mine.length)).toFixed(3), recall: +(a / song.length).toFixed(3), precision: +(b / mine.length).toFixed(3) };
}

/** Fast proxies, no model run: how far the grid moves notes, and how well the tab's notes (at their real times) match the song. */
export function diag() {
  const { q, tuning, capo } = S.tab;
  const errs = q.columns.map((c) => Math.abs(q.timeOf(c.idx) - c.time));
  const far = errs.filter((e) => e > 0.08).length;
  const song = tm.heardNotes(S.output, S.segStart, 40, 88);
  const tabReal = [];
  const tabGrid = [];
  for (const c of q.columns) c.frets.forEach((f, s) => f >= 0 && (tabReal.push({ pitch: tuning.notes[s] + capo + f, time: c.time }), tabGrid.push({ pitch: tuning.notes[s] + capo + f, time: q.timeOf(c.idx) })));
  const f1 = (mine) => {
    const a = tm.matched(song, mine).hits.size;
    const b = tm.matched(mine, song).hits.size;
    return { f: +((a + b) / (song.length + mine.length)).toFixed(3), rec: +(a / song.length).toFixed(3), prec: +(b / mine.length).toFixed(3) };
  };
  errs.sort((a, b) => a - b);
  return { cols: errs.length, gridOff80: far, medianErrMs: Math.round(errs[errs.length >> 1] * 1000), real: f1(tabReal), grid: f1(tabGrid) };
}

export async function diagAll(names = SONGS, setup) {
  const out = {};
  for (const n of names) {
    await load(n);
    if (setup) {
      setup();
      tm.retab();
    }
    out[n] = diag();
  }
  return out;
}

/** Where song notes get lost: recall of the song's heard notes after each stage of the engine. */
export function stages() {
  const { q, tuning, capo, events, notes } = S.tab;
  const song = tm.heardNotes(S.output, S.segStart, 40, 88);
  const rec = (mine) => +(tm.matched(song, mine).hits.size / song.length).toFixed(3);
  const P = (pitch, time) => ({ pitch, time });
  const raw = S.output.notes.map((n) => P(n.pitchMidi, n.startTimeSeconds));
  const clean = notes.map((n) => P(n.pitchMidi, n.startTimeSeconds));
  const grouped = events.flatMap((e) => e.notes.map((n) => P(n.pitch, e.time)));
  const fretted = events.flatMap((e) => e.frets.flatMap((f, s) => (f >= 0 ? [P(tuning.notes[s] + capo + f, e.time)] : [])));
  const cols = q.columns.flatMap((c) => c.frets.flatMap((f, s) => (f >= 0 ? [P(tuning.notes[s] + capo + f, c.time)] : [])));
  // the song notes the tab misses: overtone-like (an octave/12th/2 octaves above a tab note at that time) or not
  const hit = tm.matched(song, cols).hits;
  const miss = song.filter((n) => !hit.has(n));
  const over = miss.filter((n) => cols.some((m) => [12, 19, 24].includes(n.pitch - m.pitch) && Math.abs(m.time - n.time) < 0.1));
  const lost = miss.filter((n) => !over.includes(n));
  const inRaw = lost.filter((n) => raw.some((m) => m.pitch === n.pitch && Math.abs(m.time - n.time) <= 0.08)).length;
  return { song: song.length, raw: rec(raw), clean: rec(clean), grouped: rec(grouped), fretted: rec(fretted), cols: rec(cols), missOvertoneLike: over.length, missOther: lost.length, missOtherButInRaw: inRaw };
}

export async function stagesAll(names = SONGS) {
  const out = {};
  for (const n of names) {
    await load(n);
    out[n] = stages();
  }
  return out;
}

/** Song notes the clean-up removed, by rule, with their onset/amp, and whether the played tab would still contain them. */
export function removed() {
  const { why } = S.tab;
  const song = tm.heardNotes(S.output, S.segStart, 40, 88);
  const by = {};
  for (const [n, r] of why) {
    const inSong = song.some((m) => m.pitch === n.pitchMidi && Math.abs(m.time - n.startTimeSeconds) <= 0.08);
    const k = `${r}${inSong ? '' : '(notInSong)'}`;
    (by[k] ||= { n: 0, onset: 0, amp: 0 }).n++;
    by[k].onset += n.onset;
    by[k].amp += n.amplitude;
  }
  for (const v of Object.values(by)) {
    v.onset = +(v.onset / v.n).toFixed(2);
    v.amp = +(v.amp / v.n).toFixed(2);
  }
  return by;
}
export async function removedAll(names = SONGS) {
  const out = {};
  for (const n of names) {
    await load(n);
    out[n] = removed();
  }
  return out;
}

/** Against known true notes (finger.wav from tools/make_fingerstyle_audio.py): F1 of the tab's notes at their real times. */
export async function truth() {
  const notes = await (await fetch('_bench/finger.json')).json();
  await load('finger', 0, 30);
  const { q, tuning, capo } = S.tab;
  const mine = q.columns.flatMap((c) => c.frets.flatMap((f, s) => (f >= 0 ? [{ pitch: tuning.notes[s] + capo + f, time: c.time }] : [])));
  const a = tm.matched(notes, mine).hits;
  const b = tm.matched(mine, notes).hits.size;
  return { f: +((a.size + b) / (notes.length + mine.length)).toFixed(3), rec: +(a.size / notes.length).toFixed(3), prec: +(b / mine.length).toFixed(3), missed: notes.filter((n) => !a.has(n)).map((n) => `${n.pitch}@${n.time.toFixed(2)}`).join(' ') };
}

// The pane is often hidden: the browser then slows timers to a crawl, and the model waits on them.
// Run short timers and animation frames through a message channel instead (bench only).
if (!window.__fast) {
  const ch = new MessageChannel();
  const q = [];
  ch.port1.onmessage = () => q.shift()?.();
  const raf = window.requestAnimationFrame.bind(window);
  const st = window.setTimeout.bind(window);
  window.requestAnimationFrame = (cb) => (String(cb).includes('paused') ? raf(cb) : (q.push(() => cb(performance.now())), ch.port2.postMessage(0), 1));
  window.setTimeout = (fn, d, ...a) => ((d || 0) < 50 && typeof fn === 'function' ? (q.push(() => fn(...a)), ch.port2.postMessage(0), 1) : st(fn, d, ...a));
  window.__fast = true;
}

export const wait = (ms) => new Promise((r) => {
  const t = performance.now();
  const c = new MessageChannel();
  c.port1.onmessage = () => (performance.now() - t > ms ? r() : c.port2.postMessage(0));
  c.port2.postMessage(0);
});

/** Run several settings in the background (pane hidden = slow); results land in window.__var. list: [[name, setup]] */
export function variants(list, names = SONGS) {
  window.__var = {};
  (async () => {
    for (const [k, setup] of list) {
      const r = await run(names, setup);
      window.__var[k] = { mean: r.mean, per: Object.fromEntries(Object.entries(r.rows).map(([n, v]) => [n, v.score])) };
    }
    window.__var.done = true;
  })();
}


/** Quantiles of note.jump (see pitchJump) for kept notes and for the notes each clean-up rule drops. */
export async function jumpsByRule(names = SONGS) {
  const qs = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => +a[Math.floor(p * a.length)].toFixed(1)) : []; };
  const out = {};
  for (const name of names) {
    await load(name);
    const by = { kept: S.tab.notes };
    for (const [n, r] of S.tab.why) (by[r] ||= []).push(n);
    out[name] = Object.fromEntries(Object.entries(by).map(([r, ns]) => [r, { n: ns.length, jump: qs(ns.map((n) => n.jump)) }]));
  }
  return out;
}

/** Meter facts for the loaded song: chosen signature, tempo, beat length, and the typical gap between notes. */
export function meter() {
  const { bpm, sig, events, q } = S.tab;
  const gaps = events.slice(1).map((e, i) => e.time - events[i].time).filter((g) => g > 0.06).sort((a, b) => a - b);
  const beat = (q.timeOf(q.grid * 40) - q.timeOf(q.grid * 20)) / 20;
  const bars = q.barStarts.slice(1).map((s, i) => (s - q.barStarts[i]) / q.grid);
  const hist = {};
  for (const b of bars) hist[b] = (hist[b] || 0) + 1;
  return { sig, bpm, beatMs: Math.round(beat * 1000), gapMs: [0.25, 0.5, 0.75].map((p) => Math.round(gaps[Math.floor(p * gaps.length)] * 1000)), barLengths: hist };
}
export async function meterAll(names) {
  const out = {};
  for (const n of names) {
    await load(n);
    out[n] = meter();
  }
  return out;
}

/** Detected vs expected time signature for songs with a known meter, plus what decided 3/4 vs 6/8. */
export async function meters(expected) {
  const out = {};
  for (const [n, want] of Object.entries(expected)) {
    await load(n);
    out[n] = { want, got: S.tab.sig, ok: S.tab.sig === want, tempo: S.tab.tempo, six: S.tab.bars?.six && { ratio: +S.tab.bars.six.ratio.toFixed(2), split: +S.tab.bars.six.split.toFixed(2) } };
  }
  const ok = Object.values(out).filter((r) => r.ok).length;
  return { ok: `${ok}/${Object.keys(out).length}`, out };
}

/** Grid errors in detail: how many columns were pushed to a later step (their step was taken) and how far. */
export function pushes() {
  const { q } = S.tab;
  const out = { cols: q.columns.length, pushed: 0, far: [], stepMs: Math.round((q.timeOf(q.grid * 20 + 1) - q.timeOf(q.grid * 20)) * 1000) };
  for (const c of q.columns) {
    const want = q.idxOf(c.time);
    const err = q.timeOf(c.idx) - c.time;
    if (c.idx !== Math.max(0, want)) out.pushed++;
    if (Math.abs(err) > 0.08) out.far.push(Math.round(err * 1000));
  }
  return out;
}

/** Like meters(), with what the 3/4-vs-4/4 decision saw (accent contrast per bar length, struck-bass lead). */
export async function meterWhy(expected) {
  const out = {};
  let ok = 0;
  for (const [n, want] of Object.entries(expected)) {
    await load(n);
    const w = S.tab.bars.why || { tops: {}, bass3: NaN, bass4: NaN }; // none when counted straight in eighths
    const got = S.tab.sig;
    if (got === want) ok++;
    out[n] = `${got}${got === want ? '' : ' (want ' + want + ')'} t3 ${w.tops[3]?.toFixed(2)} t4 ${w.tops[4]?.toFixed(2)} b3 ${w.bass3.toFixed(2)} b4 ${w.bass4.toFixed(2)}`;
  }
  return { ok: `${ok}/${Object.values(expected).filter((v) => v !== '?').length}`, out };
}
