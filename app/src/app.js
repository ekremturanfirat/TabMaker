import { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } from '@spotify/basic-pitch';
import {
  TUNINGS, midiToHz, noteName, playableRange, groupEvents, assignFrets, estimateTempo,
  quantize, toMeasures, renderText, cellString, removeGhostNotes, findTechniques, techniqueMarks, TECH_LEGEND, trackBeats, findBars, splitBeats,
} from './tab.js';
import { createHandView } from './hands.js';

const MODEL_RATE = 22050;
const GRID_MOVED = 0.08; // seconds a note may move to its grid step before you can hear it
const GRID_FINER = 0.03; // share of notes moved that much that makes the grid twice as fine
const DOTTED_QUARTER_MAX = 95; // fastest 6/8 beat (♩. BPM); a faster beat split in three is a quarter in triplets
const FRAMES_PER_SEC = MODEL_RATE / 256;

const $ = (id) => document.getElementById(id);
const el = {
  form: $('linkForm'), url: $('url'), file: $('file'), go: $('go'),
  status: $('status'), stage: $('stage'), bar: $('bar'), error: $('error'),
  result: $('result'), title: $('songTitle'), meta: $('meta'), audio: $('audio'),
  tab: $('tab'), follow: $('follow'), synth: $('synth'), download: $('download'), copy: $('copy'),
  tuning: $('tuning'), capo: $('capo'), mode: $('mode'), sens: $('sens'), minLen: $('minLen'),
  minAmp: $('minAmp'), maxFret: $('maxFret'), grid: $('grid'), beats: $('beats'),
  bpm: $('bpm'), bpmAuto: $('bpmAuto'), clean: $('clean'), tech: $('tech'), from: $('from'), to: $('to'), relisten: $('relisten'),
  sensVal: $('sensVal'), minAmpVal: $('minAmpVal'),
  fretboard: $('fretboard'), handview: $('handview'), handsMode: $('handsMode'),
  compare: $('compare'), compareOut: $('compareOut'), along: $('along'),
};

for (const [key, t] of Object.entries(TUNINGS)) el.tuning.add(new Option(t.name, key));

const state = {
  title: '', blob: null, decoded: null, output: null, segStart: 0,
  tab: null, cellsByIdx: new Map(), lastHi: [], synth: null, along: null, compare: null, comparing: false,
};

// handy for poking at results from the dev console
// compare() plays the tab, listens to it and scores it against the song (see below)
window.tabmaker = {
  state, compare: () => compare(), retab: () => retab(), listen: () => listen(),
  runModel: (...a) => runModel(...a), heardNotes: (...a) => heardNotes(...a), matched: (...a) => matched(...a),
  lib: { outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime, estimateTempo, trackBeats, findBars, splitBeats },
};

// The website copy (tools/build-site.mjs) sets <body data-mode="static">: no server there,
// so only file upload works. The page served by server.py on your PC can also use links.

let model = null;
const getModel = () => (model ??= new BasicPitch(new URL('model/model.json', import.meta.url).href));

// ---------- pipeline ----------

function showStage(text, pct) {
  el.status.hidden = false;
  el.stage.textContent = text;
  el.bar.style.width = `${Math.round((pct ?? 0) * 100)}%`;
  el.bar.parentElement.classList.toggle('indeterminate', pct == null);
}

function showError(msg) {
  el.status.hidden = true;
  el.error.hidden = false;
  el.error.textContent = msg;
}

async function run(getBlob) {
  el.error.hidden = true;
  el.go.disabled = true;
  try {
    const { blob, title } = await getBlob();
    state.blob = blob;
    state.title = title;
    showStage('Decoding audio…', null);
    const ctx = new AudioContext();
    state.decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    el.audio.src = URL.createObjectURL(blob);
    el.title.textContent = title;
    await listen();
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  } finally {
    el.go.disabled = false;
  }
}

async function fromLink(url) {
  showStage('Downloading audio from the link…', null);
  let res;
  try {
    // the X-TabMaker header tells the server this request comes from its own page
    res = await fetch(`api/audio?url=${encodeURIComponent(url)}`, { headers: { 'X-TabMaker': '1' } });
  } catch {
    throw new Error('TabMaker stopped. Double-click "Start TabMaker" (or the button on the website), then try again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Download failed (${res.status})`);
  }
  const title = decodeURIComponent(res.headers.get('X-Title') || 'Untitled');
  return { blob: await res.blob(), title };
}

/** Resample the chosen part of the song to 22.05 kHz mono and run the note-detection model. */
async function listen() {
  const dur = state.decoded.duration;
  const start = Math.min(Math.max(0, parseFloat(el.from.value) || 0), dur);
  const end = Math.min(dur, parseFloat(el.to.value) || dur);
  if (end - start < 1) throw new Error('The selected part is shorter than 1 second.');

  showStage('Preparing audio…', null);
  const off = new OfflineAudioContext(1, Math.ceil((end - start) * MODEL_RATE), MODEL_RATE);
  const src = off.createBufferSource();
  src.buffer = state.decoded;
  src.connect(off.destination);
  src.start(0, start, end - start);
  const mono = await off.startRendering();

  showStage('Loading the listening model…', null);
  const { frames, onsets, contours } = await runModel(mono, (p, eta) => showStage(`Listening for notes… ${Math.round(p * 100)}%${eta}`, p));
  state.output = { frames, onsets, contours, samples: mono.getChannelData(0) };
  state.segStart = start;
  el.status.hidden = true;
  el.result.hidden = false;
  retab();
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Run the note-detection model on 22.05 kHz mono audio. onProgress(fraction, " · about N s left"). */
async function runModel(buffer, onProgress) {
  const bp = getModel();
  await bp.model;
  const frames = [];
  const onsets = [];
  const contours = [];
  const t0 = performance.now();
  await bp.evaluateModel(
    buffer,
    (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
    (p) => {
      const secs = (performance.now() - t0) / 1000;
      onProgress(p, p > 0.05 ? ` · about ${Math.ceil((secs / p) * (1 - p))} s left` : '');
    },
  );
  return { frames, onsets, contours };
}

/** Everything after the model: notes -> fingerings -> grid -> tab. Fast, so it reruns on every option change. */
function retab() {
  if (!state.output) return;
  const tuning = TUNINGS[el.tuning.value];
  const capo = +el.capo.value || 0;
  const maxFret = +el.maxFret.value || 15;
  const s = +el.sens.value;
  const onsetThreshold = 0.75 - s * 0.05;
  const { low, high } = playableRange(tuning, capo, maxFret);

  const { frames, onsets, contours, samples } = state.output;
  // turning the model output into notes takes seconds on a long song: only redo it when its inputs change
  const key = `${s}|${el.minLen.value}|${low}|${high}`;
  if (state.output.notesKey !== key) {
    const raw = outputToNotesPoly(
      frames, onsets,
      onsetThreshold,
      0.42 - s * 0.024, // frame threshold
      Math.max(1, Math.round((+el.minLen.value / 1000) * FRAMES_PER_SEC)),
      true, midiToHz(high + 0.5), midiToHz(low - 0.5),
    );
    const bent = addPitchBendsToNoteEvents(contours, raw);
    state.output.notes = noteFramesToTime(bent).map((n, i) => ({
      ...n,
      startTimeSeconds: n.startTimeSeconds + state.segStart,
      startFrame: bent[i].startFrame,
      onset: onsetStrength(onsets, bent[i]),
      attack: attackRatio(samples, n.startTimeSeconds),
      jump: pitchJump(samples, n.startTimeSeconds, n.pitchMidi),
    }));
    state.output.notesKey = key;
  }
  let notes = state.output.notes;
  const why = new Map(); // why each removed note was dropped (for checking against the song)
  if (el.clean.checked) notes = removeGhostNotes(notes, { faintOnset: onsetThreshold + 0.1, why });

  const grouped = groupEvents(notes, { low, high, minAmp: +el.minAmp.value / 100, mode: el.mode.value });
  const events = techniqueMarks(assignFrets(findTechniques(grouped, { level: el.tech.value, contours }), tuning, capo, maxFret));
  if (!events.length) {
    el.tab.textContent = 'No guitar notes were found. Try raising the sensitivity or lowering "Ignore quiet notes".';
    state.tab = null;
    return;
  }

  let { bpm } = estimateTempo(events);
  if (el.bpmAuto.checked) el.bpm.value = bpm;
  else bpm = Math.min(300, Math.max(30, +el.bpm.value || bpm));

  // the beats follow the player's tempo; bar lines follow where beat 1 falls
  let beatTimes = trackBeats(events, { bpm });
  // A beat the notes split in three is a dotted quarter of 6/8, counted in its thirds (eighths), when it
  // is slow enough to be one and doesn't group in threes; else a quarter played in triplets
  const auto = el.beats.value === 'auto';
  let thirds = auto && splitBeats(events, beatTimes);
  let triplets = false;
  if (thirds && (bpm > DOTTED_QUARTER_MAX || findBars(events, beatTimes, { choices: [4, 3], bpm }).beats === 3)) {
    thirds = null;
    triplets = true;
  }
  if (thirds) beatTimes = thirds;
  const beatBpm = thirds ? bpm * 3 : bpm; // tempo of the beats counted
  const bars = findBars(events, beatTimes, { choices: thirds ? [6] : triplets ? [4, 3] : auto ? [4, 3, 6] : [+el.beats.value], bpm: beatBpm });
  const beats = bars.beats;
  // 6/8 counts the tempo's beats as eighth notes: six to a bar, half as many grid steps per beat
  const sig = beats === 6 ? '6/8' : `${beats}/4`;
  const grid = triplets ? (+el.grid.value === 4 ? 6 : 3) : beats === 6 ? Math.max(1, Math.round(+el.grid.value / 2)) : +el.grid.value;
  // 6/8 is felt (and written) in dotted quarters: three eighths
  const tempo = beats === 6 ? `~${Math.round(beatBpm / 3)} BPM (♩.)` : `~${beatBpm} BPM`;

  let q = quantize(events, { beats: beatTimes, bars: bars.starts, grid, beatsPerBar: beats });
  // a grid too coarse for the playing (quick runs, ornaments at a slow tempo) piles notes onto taken
  // steps and moves them audibly: use one twice as fine
  const moved = (qq) => qq.columns.filter((c) => Math.abs(qq.timeOf(c.idx) - c.time) > GRID_MOVED).length;
  if (grid < 8 && moved(q) > GRID_FINER * q.columns.length) {
    const fine = quantize(events, { beats: beatTimes, bars: bars.starts, grid: grid * 2, beatsPerBar: beats });
    if (moved(fine) < moved(q)) q = fine;
  }
  const measures = toMeasures(q);
  state.tab = { q, measures, tuning, capo, bpm, tempo, sig, events, notes, why, bars };

  const pitchesUsed = new Set(events.flatMap((e) => e.notes.map((n) => n.pitch)));
  const lo = Math.min(...pitchesUsed);
  const hi = Math.max(...pitchesUsed);
  el.meta.textContent =
    `${events.length} notes/chords · ${measures.length} bars of ${sig} · ${tempo} · ` +
    `${tuning.name}${capo ? ` · capo ${capo}` : ''} · range ${noteName(lo)}–${noteName(hi)}`;
  renderHtml();
  drawFretboard();
  hv.key = null;
  highlight(el.audio.currentTime || 0);
  if (state.along) startAlong(); // keep playing along with the new tab
}

/** How strongly the model heard a note being struck (its onset peak, 0–1). Hammer-ons and slides are weak. */
function onsetStrength(onsets, n) {
  let best = 0;
  for (let f = Math.max(0, n.startFrame - 1); f <= n.startFrame + 2 && f < onsets.length; f++) {
    best = Math.max(best, onsets[f][n.pitchMidi - 21] ?? 0);
  }
  return best;
}

/**
 * Pick click: how much the high frequencies jump at a note's start (sharpest 10 ms vs. the 55 ms before).
 * A picked note jumps a lot; a hammer-on, pull-off or slide hardly at all.
 */
function attackRatio(x, t) {
  const energy = (from, to) => {
    const a = Math.max(1, Math.round(from * MODEL_RATE));
    const b = Math.min(x.length, Math.round(to * MODEL_RATE));
    let e = 0;
    for (let i = a; i < b; i++) e += (x[i] - x[i - 1]) ** 2;
    return e / Math.max(1, b - a);
  };
  let after = 0;
  for (let c = t - 0.02; c <= t + 0.03; c += 0.005) after = Math.max(after, energy(c, c + 0.01));
  return after / (energy(t - 0.08, t - 0.025) + 1e-9);
}

/** Energy at one frequency and its octave in samples [a, a + n) (Goertzel). */
function toneEnergy(x, a, n, hz) {
  let e = 0;
  for (const f of [hz, 2 * hz]) {
    const c = 2 * Math.cos((2 * Math.PI * f) / MODEL_RATE);
    let s1 = 0;
    let s2 = 0;
    for (let i = Math.max(0, a); i < Math.min(x.length, a + n); i++) {
      const s0 = x[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    e += s1 * s1 + s2 * s2 - c * s1 * s2;
  }
  return e;
}

/**
 * How much a note's own pitch gets louder at its start (loudest window in the first 40 ms vs. just
 * before). A string that is plucked again jumps; a string that only keeps ringing doesn't, even when
 * the model hears a new start there because another string was plucked.
 */
function pitchJump(x, t, midi) {
  const hz = midiToHz(midi);
  const n = 2 * Math.max(256, Math.round((2 * MODEL_RATE) / hz)); // a few periods, at least ~23 ms
  const i = Math.round(t * MODEL_RATE);
  const before = toneEnergy(x, i - n - Math.round(0.015 * MODEL_RATE), n, hz);
  let after = 0;
  for (let d = 0; d <= 0.04; d += 0.01) after = Math.max(after, toneEnergy(x, i + Math.round(d * MODEL_RATE) - n / 2, n, hz));
  return after / (before + 1e-9);
}

// ---------- tab display ----------

function charWidth() {
  const probe = document.createElement('span');
  probe.textContent = '0'.repeat(50);
  el.tab.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 50;
  probe.remove();
  return w || 8;
}

function renderHtml() {
  const { measures, tuning, q } = state.tab;
  const avail = Math.floor(el.tab.clientWidth / charWidth()) - 4;
  const labelW = Math.max(...tuning.labels.map((l) => l.length));
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  let html = '';
  let m = 0;
  while (m < measures.length) {
    // fit as many bars as the width allows
    let width = labelW + 1;
    let n = 0;
    while (m + n < measures.length) {
      const w = measures[m + n].reduce((a, c) => a + cellString(c, 0).length, 0) + 1;
      if (n > 0 && width + w > avail) break;
      width += w;
      n++;
    }
    const row = measures.slice(m, m + n);
    let nums = ' '.repeat(labelW + 1);
    row.forEach((meas, i) => {
      const w = meas.reduce((a, c) => a + cellString(c, 0).length, 0) + 1;
      nums += `<span class="bar-no" data-bar="${m + i}">${String(m + i + 1)}</span>${' '.repeat(Math.max(0, w - String(m + i + 1).length))}`;
    });
    html += `<div class="system">${nums}\n`;
    for (let s = 5; s >= 0; s--) {
      html += `<span class="lbl">${esc(tuning.labels[s].padEnd(labelW))}</span>|`;
      row.forEach((meas, i) => {
        const base = q.barStarts[m + i];
        meas.forEach((col, k) => {
          // technique marks are drawn as symbols (drawTechniques); the letters' room stays as dashes
          const played = col && col.frets[s] >= 0;
          const txt = played ? String(col.frets[s]).padEnd(cellString(col, s).length, '-') : cellString(col, s);
          html += played ? `<span class="c n" data-i="${base + k}" data-s="${s}">${txt}</span>` : `<span class="c" data-i="${base + k}">${txt}</span>`;
        });
        html += '|';
      });
      html += '\n';
    }
    html += '</div>';
    m += n;
  }
  el.tab.innerHTML = html;

  state.cellsByIdx = new Map();
  for (const span of el.tab.querySelectorAll('.c')) {
    const i = +span.dataset.i;
    if (!state.cellsByIdx.has(i)) state.cellsByIdx.set(i, []);
    state.cellsByIdx.get(i).push(span);
  }
  state.lastHi = [];
  drawTechniques();
  showCompare();
}

const BEND_LABEL = { 1: '½', 2: 'full', 3: '1½' };

/**
 * Draw the technique symbols over the tab: an arc joins a hammer-on / pull-off, a slanted line is
 * a slide, a curved arrow is a bend (with ½ / full) and its release, a wavy line is vibrato.
 */
function drawTechniques() {
  const { q } = state.tab;
  const cw = charWidth();
  const spans = new Map();
  for (const sp of el.tab.querySelectorAll('.c.n')) spans.set(`${sp.dataset.i}:${sp.dataset.s}`, sp);
  const layers = new Map();
  const add = (sys, svg) => layers.set(sys, (layers.get(sys) || '') + svg);
  q.columns.forEach((col, k) => {
    col.tech?.forEach((t, s) => {
      if (!t || !(t.bend || t.vibrato || t.link)) return;
      const sp = spans.get(`${col.idx}:${s}`);
      if (!sp) return;
      const sys = sp.closest('.system');
      const box = sys.getBoundingClientRect();
      const r = sp.getBoundingClientRect();
      const x0 = r.left - box.left;
      const x1 = x0 + String(col.frets[s]).length * cw; // end of the fret number
      const top = r.top - box.top + 2;
      const mid = r.top - box.top + r.height / 2;
      let x = x1 + 1;
      if (t.vibrato) {
        let d = `M${x0} ${top - 1}`;
        for (let w = 0; w < 4; w++) d += ` q${cw * 0.25} -3 ${cw * 0.5} 0 t${cw * 0.5} 0`;
        add(sys, `<path d="${d}"/>`);
      }
      if (t.bend) {
        const ax = x + cw * 1.1;
        add(sys, `<path d="M${x} ${mid} Q${ax} ${mid} ${ax} ${top - 9}"/><path d="M${ax - 3} ${top - 5} L${ax} ${top - 10} L${ax + 3} ${top - 5}"/>`);
        add(sys, `<text x="${ax}" y="${top - 12}">${BEND_LABEL[t.bend.semis] || t.bend.semis}</text>`);
        x = ax + cw * 0.5;
        if (t.bend.release != null) {
          const bx = x + cw * 1.1;
          add(sys, `<path d="M${x} ${top - 9} Q${x} ${mid} ${bx} ${mid}"/><path d="M${bx - 4} ${mid - 3} L${bx + 1} ${mid} L${bx - 4} ${mid + 3}"/>`);
        }
      }
      if (t.link) {
        // the note it leads to: the next column, maybe on the next row of the tab
        const next = q.columns[k + 1];
        const target = next && spans.get(`${next.idx}:${s}`);
        const same = target && target.closest('.system') === sys;
        const tr = same && target.getBoundingClientRect();
        const tx0 = same ? tr.left - box.left : box.width - 4;
        const tx1 = same ? tx0 + String(next.frets[s]).length * cw : tx0;
        if (t.link === 'h' || t.link === 'p') {
          const a = (x0 + x1) / 2;
          const b = (tx0 + tx1) / 2;
          add(sys, `<path d="M${a} ${top} Q${(a + b) / 2} ${top - 11} ${b} ${top}"/>`);
        } else {
          const up = t.link === '/';
          add(sys, `<path d="M${x} ${up ? mid + 5 : mid - 5} L${tx0 - 1} ${up ? mid - 5 : mid + 5}"/>`);
        }
      }
    });
  });
  for (const [sys, svg] of layers) {
    sys.insertAdjacentHTML('beforeend', `<svg class="tech" width="${sys.scrollWidth}" height="${sys.offsetHeight}" aria-hidden="true">${svg}</svg>`);
  }
}

el.tab.addEventListener('click', (e) => {
  const cell = e.target.closest('.c');
  if (!cell || !state.tab) return;
  const { q } = state.tab;
  el.audio.currentTime = Math.max(0, q.timeOf(+cell.dataset.i) - 0.05);
  highlight(el.audio.currentTime);
});

function highlight(time) {
  if (!state.tab) return;
  const { q } = state.tab;
  const idx = q.idxOf(time);
  updateFretboard(idx);
  updateHands(idx);
  for (const s of state.lastHi) s.classList.remove('hi');
  state.lastHi = state.cellsByIdx.get(idx) || [];
  for (const s of state.lastHi) s.classList.add('hi');
  const userScrolling = performance.now() - lastUserScroll < 4000;
  if (el.follow.checked && !userScrolling && state.lastHi.length && !el.audio.paused) {
    const sys = state.lastHi[0].closest('.system');
    const r = sys.getBoundingClientRect();
    const top = el.audio.closest('.player').getBoundingClientRect().bottom + 10;
    if (r.top < top || r.bottom > innerHeight - 20) sys.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ---------- live fretboard: where the fingers go right now ----------
// Left hand: a hand that slides along the neck, fingers 1-4 pressing their strings (index on the
// hand position's fret). Right hand: p i m a on the strings being plucked, by the sound hole.

const fb = { n: 15, key: null, layer: null, hand: null };
const FB_W = 1000; // end of the neck; the right-hand zone is drawn after it
const FB_PICK = 140;
const FB_NUT = 70;
const FB_TOP = 62; // room above the strings for the hand
const FB_GAP = 18;
const PALM_Y = 6;
const PALM_B = 40; // bottom edge of the palm, where the fingers start
const fretW = () => (FB_W - FB_NUT - 12) / fb.n;
const fretX = (f) => FB_NUT + f * fretW();
const dotX = (f) => (f === 0 ? FB_NUT - 18 : (fretX(f - 1) + fretX(f)) / 2);
const stringY = (s) => FB_TOP + (5 - s) * FB_GAP; // high e on top, like the tab
const REST_Y = FB_TOP - 12; // a finger that presses nothing hovers above the high e
const PIMA = ['p', 'p', 'p', 'i', 'm', 'a']; // classical rule: thumb on the 3 bass strings, i m a on G B e

function drawFretboard() {
  const { tuning, q } = state.tab;
  const highest = Math.max(0, ...q.columns.flatMap((c) => c.frets), ...q.columns.map((c) => (c.hand ?? 1) + 3));
  fb.n = Math.min(24, Math.max(12, highest + 1));
  const bottom = stringY(0);
  const fw = fretW();
  let svg = `<svg viewBox="0 0 ${FB_W + FB_PICK} ${bottom + 30}" role="img" aria-label="Fretboard: left-hand fingers and right-hand p i m a for the notes being played">`;
  // right-hand zone: sound hole
  svg += `<circle class="fb-hole" cx="${FB_W + 78}" cy="${(FB_TOP + bottom) / 2}" r="${(bottom - FB_TOP) / 2 + 14}"/>`;
  // inlay dots
  for (let f = 1; f <= fb.n; f++) {
    const x = dotX(f);
    if (f % 12 === 0) {
      svg += `<circle class="fb-mark" cx="${x}" cy="${stringY(4) + FB_GAP / 2}" r="5"/><circle class="fb-mark" cx="${x}" cy="${stringY(1) - FB_GAP / 2 + FB_GAP}" r="5"/>`;
    } else if ([3, 5, 7, 9].includes(f % 12)) {
      svg += `<circle class="fb-mark" cx="${x}" cy="${(stringY(5) + bottom) / 2}" r="5"/>`;
    }
  }
  for (let f = 1; f <= fb.n; f++) svg += `<line class="fb-fret" x1="${fretX(f)}" x2="${fretX(f)}" y1="${FB_TOP}" y2="${bottom}"/>`;
  svg += `<line class="fb-nut" x1="${FB_NUT}" x2="${FB_NUT}" y1="${FB_TOP - 2}" y2="${bottom + 2}"/>`;
  for (let s = 0; s < 6; s++) {
    svg += `<line class="fb-string" x1="${FB_NUT - 30}" x2="${FB_W + FB_PICK - 6}" y1="${stringY(s)}" y2="${stringY(s)}" style="stroke-width:${0.8 + (5 - s) * 0.25}"/>`;
    svg += `<text class="fb-label" x="12" y="${stringY(s) + 4}">${tuning.labels[s]}</text>`;
  }
  for (let f = 1; f <= fb.n; f++) {
    if ([3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f)) svg += `<text class="fb-num" x="${dotX(f)}" y="${bottom + 26}">${f}</text>`;
  }
  svg += `<text class="fb-zone" x="${FB_W + 78}" y="${FB_TOP - 30}">right hand</text>`;
  svg += `<g class="fb-live"></g>`;
  // the left hand, drawn at fret 1 and moved with a transform so it glides between positions
  svg += `<g class="fb-handg" style="transform: translateX(${dotX(1)}px)">`;
  svg += `<rect class="fb-palm" x="${-fw * 0.62}" y="${PALM_Y}" width="${fw * 4.24}" height="${PALM_B - PALM_Y}" rx="14"/>`;
  svg += `<ellipse class="fb-thumb" cx="${fw * 0.6}" cy="${bottom + 9}" rx="${fw * 0.55}" ry="6"/>`;
  for (let k = 1; k <= 4; k++) {
    const x = (k - 1) * fw;
    svg += `<rect class="fb-finger f${k}" x="${x - 6}" y="${PALM_B - 6}" width="12" rx="6" style="height:${REST_Y - PALM_B + 12}px"/>`;
    svg += `<rect class="fb-barre" x="${x - 7}" width="14" rx="7" style="y:${REST_Y}px;height:0px" data-k="${k}"/>`;
    svg += `<circle class="fb-tip f${k}" cx="${x}" r="9" style="cy:${REST_Y}px"/>`;
    svg += `<text class="fb-tip-t" x="${x}" style="transform: translateY(${REST_Y + 4}px)">${k}</text>`;
  }
  svg += `</g></svg>`;
  el.fretboard.innerHTML = svg;
  fb.layer = el.fretboard.querySelector('.fb-live');
  fb.hand = el.fretboard.querySelector('.fb-handg');
  fb.key = null;
}

/** Index of the last tab column at or before grid step `idx` (binary search). */
function columnAt(idx) {
  const cols = state.tab.q.columns;
  let lo = 0;
  let hi = cols.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cols[mid].idx <= idx) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Put the left hand at fret `hand` with each finger on its strings (or resting). */
function poseHand(col) {
  const hand = col?.hand ?? null;
  fb.hand.classList.toggle('idle', !col);
  if (hand != null) fb.hand.style.transform = `translateX(${dotX(hand)}px)`;
  for (let k = 1; k <= 4; k++) {
    // strings this finger presses (several = a barre, or a flattened finger)
    const strings = col ? col.frets.map((_, s) => s).filter((s) => col.fingers?.[s] === k) : [];
    const tipY = strings.length ? Math.max(...strings.map(stringY)) : REST_Y;
    const topY = strings.length ? Math.min(...strings.map(stringY)) : REST_Y;
    const finger = fb.hand.querySelector(`.fb-finger.f${k}`);
    finger.style.height = `${tipY - PALM_B + 6}px`;
    finger.classList.toggle('on', strings.length > 0);
    fb.hand.querySelector(`.fb-tip.f${k}`).style.cy = `${tipY}px`;
    fb.hand.querySelector(`.fb-tip.f${k}`).classList.toggle('on', strings.length > 0);
    fb.hand.querySelectorAll('.fb-tip-t')[k - 1].style.transform = `translateY(${tipY + 4}px)`;
    const barre = fb.hand.querySelector(`.fb-barre[data-k="${k}"]`);
    barre.style.y = `${topY - 8}px`;
    barre.style.height = `${strings.length > 1 ? tipY - topY + 16 : 0}px`;
  }
}

function updateFretboard(idx) {
  if (!fb.layer || el.fretboard.hidden) return;
  const { q } = state.tab;
  let i = columnAt(idx);
  if (i >= 0 && idx - q.columns[i].idx > q.stepsPerMeasure) i = -1; // long rest: nothing is being played
  const cur = i >= 0 ? q.columns[i] : null;
  const next = q.columns[i + 1] && q.columns[i + 1].idx - idx <= q.stepsPerMeasure ? q.columns[i + 1] : null;
  const key = `${cur?.idx}|${next?.idx}`;
  if (key === fb.key) return;
  fb.key = key;

  let g = '';
  if (next) {
    next.frets.forEach((f, s) => {
      if (f >= 0) g += `<circle class="fb-next" cx="${dotX(f)}" cy="${stringY(s)}" r="8"/>`;
    });
  }
  if (cur) {
    cur.frets.forEach((f, s) => {
      if (f < 0) return;
      if (f === 0) g += `<circle class="fb-open" cx="${dotX(0)}" cy="${stringY(s)}" r="7"/>`;
      // right hand: which finger plucks this string
      const p = PIMA[s];
      g += `<circle class="fb-pima ${p}" cx="${FB_W + 78}" cy="${stringY(s)}" r="8.5"/><text class="fb-pima-t" x="${FB_W + 78}" y="${stringY(s) + 4}">${p}</text>`;
    });
  }
  fb.layer.innerHTML = g;
  poseHand(cur);
}

// ---------- hand view: both hands drawn in 3D, as the player sees them ----------

const hv = { view: createHandView(el.handview), key: null };

/**
 * The chord shape the left hand holds at column i: its own notes plus its neighbours' that are played
 * in the same hand position without moving a finger. In an arpeggio the whole chord stays down.
 */
function heldShape(i) {
  const { q } = state.tab;
  const c = q.columns[i];
  const frets = c.frets.slice();
  const fingers = c.fingers?.slice() ?? c.frets.map(() => -1);
  const take = (o) => {
    if (o.hand !== c.hand && o.frets.some((f) => f > 0)) return false; // the hand moved
    for (let s = 0; s < 6; s++) {
      const f = o.frets[s];
      if (f < 0) continue;
      if (frets[s] >= 0 && frets[s] !== f) return false; // same string, other fret
      const k = o.fingers?.[s];
      if (k > 0 && fingers.some((kk, ss) => kk === k && ss !== s && frets[ss] !== f)) return false; // finger busy on another fret
    }
    o.frets.forEach((f, s) => f >= 0 && ((frets[s] = f), (fingers[s] = o.fingers?.[s] ?? -1)));
    return true;
  };
  for (let j = i - 1; j >= 0 && c.idx - q.columns[j].idx <= q.stepsPerMeasure && take(q.columns[j]); j--);
  for (let j = i + 1; j < q.columns.length && q.columns[j].idx - c.idx <= q.stepsPerMeasure && take(q.columns[j]); j++);
  return { frets, fingers };
}

/** How to hold the hands for what is played around column i: arpeggio, chord, barre or single notes. */
function handTip(i, held) {
  const { q } = state.tab;
  const c = q.columns[i];
  const played = (o) => o.frets.filter((f) => f >= 0).length;
  const near = q.columns.slice(Math.max(0, i - 3), i + 4).filter((o) => Math.abs(o.idx - c.idx) <= q.stepsPerMeasure);
  const used = new Set(near.flatMap((o) => o.frets.map((f, s) => (f >= 0 ? s : -1)).filter((s) => s >= 0)));
  const barre = [1, 2, 3, 4].some((k) => held.fingers.filter((f, s) => f === k && held.frets[s] > 0).length > 1);
  // an arpeggio: one or two notes at a time, rolling over four strings or more of a chord shape held down
  const rolling = near.length >= 4 && near.filter((o) => played(o) <= 2).length >= near.length - 1 && used.size >= 4;
  if (played(c) <= 2 && rolling && held.frets.filter((f) => f >= 0).length >= 3) {
    return '<b>Arpeggio:</b> keep the whole chord shape pressed (every numbered fingertip), not only the note you hear, so the strings ring into each other' +
      `${barre ? ', the index lying flat as a barre' : ''}. The right hand stays still over the sound hole; only the fingers move: the thumb <b>p</b> ahead of <b>i m a</b> towards the neck, each finger plucking towards the palm, then back onto its string.`;
  }
  if (barre) {
    return '<b>Barre:</b> the index lies flat across the strings right behind the fret, a little on its side; the thumb behind the neck, opposite the middle finger, presses against it. Arch the other fingers so they touch only their own string.';
  }
  if (played(c) >= 3) {
    return '<b>Chord:</b> put all the fingers down together, on the very fingertips, just behind the frets; arch the knuckles so no finger mutes the next string. Pluck <b>p i m a</b> at once, closing the hand a little like a soft grip.';
  }
  return '<b>Single notes:</b> press with the fingertip just behind the fret; fingers you don’t need hover close above the strings, ready for the next note. Thumb behind the neck, wrist straight. Pick with <b>i</b> and <b>m</b> in turn, <b>p</b> on the bass strings.';
}

function updateHands(idx) {
  if (el.handview.hidden) return;
  const { q } = state.tab;
  let i = columnAt(idx);
  if (i >= 0 && idx - q.columns[i].idx > q.stepsPerMeasure) i = -1; // long rest: nothing is being played
  const key = `${i}`;
  if (key === hv.key) return;
  hv.key = key;
  const cur = i >= 0 ? q.columns[i] : null;
  const nextCol = q.columns[i + 1] && q.columns[i + 1].idx - idx <= q.stepsPerMeasure ? q.columns[i + 1] : null;
  const held = cur ? heldShape(i) : { frets: [-1, -1, -1, -1, -1, -1], fingers: [-1, -1, -1, -1, -1, -1] };
  hv.view.setTuning(state.tab.tuning.labels);
  hv.view.show({
    active: !!cur,
    hand: cur?.hand ?? nextCol?.hand ?? null,
    held: held.frets,
    fingers: held.fingers,
    sounding: cur ? cur.frets.map((f) => f >= 0) : [],
    plucks: cur ? cur.frets.map((f, s) => (f >= 0 ? { s, f: PIMA[s] } : null)).filter(Boolean) : [],
    // the next notes outside the shape being held: where the fingers have to move to
    next: nextCol && { frets: nextCol.frets.map((f, s) => (held.frets[s] === f ? -1 : f)), fingers: nextCol.fingers },
    key,
    caption: cur ? handTip(i, held) : 'Rest: the hands stay where they are, relaxed, ready for the next notes.',
  });
}

// "follow" pauses for a few seconds whenever you scroll yourself
let lastUserScroll = -Infinity;
for (const ev of ['wheel', 'touchmove']) addEventListener(ev, () => (lastUserScroll = performance.now()), { passive: true });
addEventListener('keydown', (e) => {
  if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) lastUserScroll = performance.now();
  // Space = play / pause (unless typing in a box)
  if (e.key === ' ' && !e.target.closest('input, select, textarea, button') && el.audio.src) {
    e.preventDefault();
    if (state.synth) stopSynth();
    else if (el.audio.paused) el.audio.play();
    else el.audio.pause();
  }
});

(function tick() {
  if (!el.audio.paused) highlight(el.audio.currentTime);
  else if (state.synth) highlight(state.synth.ctx.currentTime - state.synth.t0 + state.synth.from);
  requestAnimationFrame(tick);
})();

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.tab && renderHtml(), 150);
});

// ---------- tab synth (hear what the tab says) ----------

function stopSynth() {
  if (!state.synth) return;
  state.synth.ctx.close();
  state.synth = null;
  el.synth.textContent = '♪ Play the tab';
}

function playSynth() {
  if (state.synth) return stopSynth();
  if (!state.tab) return;
  el.audio.pause();
  const ctx = new AudioContext();
  const from = el.audio.currentTime || 0;
  const t0 = ctx.currentTime + 0.1;
  const master = ctx.createGain();
  master.gain.value = 0.25;
  master.connect(ctx.destination);
  const lastEnd = scheduleTab(ctx, master, from, t0);
  state.synth = { ctx, t0, from };
  el.synth.textContent = '■ Stop';
  setTimeout(() => state.synth?.ctx === ctx && stopSynth(), lastEnd * 1000 + 200);
}

// "tab along": the tab plays together with the song, so every wrong note stands out by ear
function stopAlong() {
  state.along?.close();
  state.along = null;
}

function startAlong() {
  stopAlong();
  if (!state.tab || !el.along.checked) return;
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.18;
  master.connect(ctx.destination);
  scheduleTab(ctx, master, el.audio.currentTime, ctx.currentTime);
  state.along = ctx;
}

/**
 * Schedule the tab's notes from song time `from` on, into an audio context (live or offline) whose
 * time t0 is song time `from`. Returns how many seconds after `from` the last note dies away.
 */
function scheduleTab(ctx, dest, from, t0, to = Infinity) {
  const { q, tuning, capo } = state.tab;
  let lastEnd = 0;
  q.columns.forEach((col, k) => {
    const at = q.timeOf(col.idx) - from;
    if (at < 0 || from + at > to) return;
    col.frets.forEach((f, s) => {
      if (f < 0) return;
      const tech = col.tech?.[s] || {};
      // a chord rolls from its lowest string up, 10 ms per string, like a quick downstroke or a pluck
      const t = t0 + at + (tech.linked ? 0 : col.frets.slice(0, s).filter((x) => x >= 0).length * 0.01);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(tuning.notes[s] + capo + f);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(tech.linked ? 0.3 : 0.6, t + 0.005); // hammer-ons/slides aren't picked
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      let end = t + 1.25;
      if (tech.bend) {
        const up = t + tech.bend.at;
        osc.detune.setValueAtTime(0, up);
        osc.detune.linearRampToValueAtTime(tech.bend.semis * 100, up + 0.12);
        if (tech.bend.release != null) {
          osc.detune.setValueAtTime(tech.bend.semis * 100, t + tech.bend.release);
          osc.detune.linearRampToValueAtTime(0, t + tech.bend.release + 0.12);
        }
      }
      if (tech.vibrato) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 5.5;
        depth.gain.value = 30; // cents
        lfo.connect(depth).connect(osc.detune);
        lfo.start(t + 0.1);
        lfo.stop(end);
      }
      const next = q.columns[k + 1];
      if (tech.link && next && next.frets[s] >= 0) {
        // the next note takes over this string; a slide glides into it
        const tn = t0 + q.timeOf(next.idx) - from;
        if (tech.link === '/' || tech.link === '\\') {
          osc.detune.setValueAtTime(0, Math.max(t, tn - 0.08));
          osc.detune.linearRampToValueAtTime((next.frets[s] - f) * 100, tn);
        }
        g.gain.setValueAtTime(0.3, tn);
        g.gain.linearRampToValueAtTime(0, tn + 0.02);
        end = tn + 0.03;
      }
      osc.connect(g).connect(dest);
      osc.start(t);
      osc.stop(end);
      lastEnd = Math.max(lastEnd, at + 1.3);
    });
  });
  return lastEnd;
}

el.synth.addEventListener('click', playSynth);
el.audio.addEventListener('play', () => {
  stopSynth();
  startAlong();
});
for (const ev of ['pause', 'seeking', 'ended']) el.audio.addEventListener(ev, stopAlong);
el.audio.addEventListener('seeked', () => !el.audio.paused && startAlong());
el.along.addEventListener('change', () => (el.audio.paused ? stopAlong() : startAlong()));

// ---------- compare: does the tab sound like the song? ----------
// The tab is played offline with the same synth as "Play the tab", the listening model hears that
// the way it heard the song, and the notes of both are matched: same pitch, starting within `tol`.
// Fixed thresholds (not the Sensitivity slider), so scores can be compared between settings.

const MATCH = { tol: 0.08, near: 0.3, onset: 0.5, frame: 0.3, minLen: 0.1, good: 0.75, ok: 0.55, ring: 1, rejump: 2 };

function heardNotes({ frames, onsets }, offset, low, high) {
  const raw = outputToNotesPoly(frames, onsets, MATCH.onset, MATCH.frame, Math.round(MATCH.minLen * FRAMES_PER_SEC), true, midiToHz(high + 0.5), midiToHz(low - 0.5));
  return noteFramesToTime(raw).map((n) => ({ pitch: n.pitchMidi, time: n.startTimeSeconds + offset, amp: n.amplitude }));
}

/**
 * Notes the comparison can't judge, so they count neither way:
 *  - a quieter octave, 12th or 2 octaves starting together with another note: the guitar's own
 *    overtone and a played octave sound alike to the model (and the tab synth has no octave overtone)
 *  - (with the song's audio) a start the model hears in a note that was already ringing and doesn't
 *    get louder: maybe re-plucked, maybe not
 */
function doubtful(notes, samples, start) {
  return new Set(notes.filter((n) =>
    notes.some((m) => [12, 19, 24].includes(n.pitch - m.pitch) && Math.abs(m.time - n.time) <= MATCH.tol && m.amp > n.amp) ||
    (samples && notes.some((m) => m.pitch === n.pitch && m.time < n.time - MATCH.tol && n.time - m.time <= MATCH.ring) &&
      pitchJump(samples, n.time - start, n.pitch) < MATCH.rejump)));
}

/** Notes of `a` with a partner in `b` (same pitch, onsets within tol); each partner used once. */
function matched(a, b) {
  const byPitch = new Map();
  for (const n of b) byPitch.set(n.pitch, [...(byPitch.get(n.pitch) || []), n]);
  const used = new Set();
  const hits = new Set();
  for (const n of a) {
    let best = null;
    for (const m of byPitch.get(n.pitch) || []) {
      if (!used.has(m) && Math.abs(m.time - n.time) <= MATCH.tol && (!best || Math.abs(m.time - n.time) < Math.abs(best.time - n.time))) best = m;
    }
    if (best) {
      used.add(best);
      hits.add(n);
    }
  }
  return { hits, used };
}

async function compare() {
  if (!state.tab || state.comparing) return null;
  const tab = state.tab;
  const { samples } = state.output;
  const start = state.segStart;
  const label = el.compare.textContent;
  state.comparing = true;
  el.compare.disabled = true;
  try {
    el.compare.textContent = 'Playing the tab…';
    const off = new OfflineAudioContext(1, samples.length, MODEL_RATE);
    scheduleTab(off, off.destination, start, 0, start + samples.length / MODEL_RATE);
    const played = await off.startRendering();
    // same loudness as the song, so the model hears both alike
    const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const ch = played.getChannelData(0);
    const k = peak(samples) / (peak(ch) || 1);
    for (let i = 0; i < ch.length; i++) ch[i] *= k;
    const heard = await runModel(played, (p) => (el.compare.textContent = `Listening to the tab… ${Math.round(p * 100)}%`));

    const { low, high } = playableRange(tab.tuning, tab.capo, 24);
    // notes neither side can be judged on (see doubtful) leave both sides, with what only they match
    const heardSong = heardNotes(state.output, start, low, high);
    const heardTab = heardNotes(heard, start, low, high);
    const songOff = doubtful(heardSong, samples, start);
    const tabOff = doubtful(heardTab, null, start);
    const clear = (a, aOff, b, bOff) => {
      const keep = a.filter((n) => !aOff.has(n));
      const fit = matched(keep, b.filter((n) => !bOff.has(n))).hits;
      const shadow = matched(keep.filter((n) => !fit.has(n)), [...bOff]).hits;
      return keep.filter((n) => !shadow.has(n));
    };
    const song = clear(heardSong, songOff, heardTab, tabOff);
    const mine = clear(heardTab, tabOff, heardSong, songOff);
    const notJudged = heardSong.length - song.length;
    const found = matched(song, mine).hits;
    const right = matched(mine, song).hits;

    // per bar: which song notes the tab misses, which tab notes the song doesn't have
    const { q } = tab;
    const barTimes = q.barStarts.map((s) => q.timeOf(s));
    const barOf = (t) => {
      let b = 0;
      while (b + 1 < barTimes.length && barTimes[b + 1] <= t + MATCH.tol / 2) b++;
      return b;
    };
    const bars = barTimes.map(() => ({ song: 0, tab: 0, hit: 0, missing: [], extra: [], late: [] }));
    // right note, wrong time: the song has that pitch close by (a rhythm error, not a pitch error)
    const nearInSong = (n) => song.some((m) => m.pitch === n.pitch && Math.abs(m.time - n.time) <= MATCH.near);
    for (const n of song) {
      const b = bars[barOf(n.time)];
      b.song++;
      if (found.has(n)) b.hit++;
      else b.missing.push(n.pitch);
    }
    for (const n of mine) {
      const b = bars[barOf(n.time)];
      b.tab++;
      if (!right.has(n)) (nearInSong(n) ? b.late : b.extra).push(n.pitch);
    }
    for (const b of bars) b.score = b.song + b.tab ? (2 * b.hit) / (b.song + b.tab) : null;
    const score = song.length + mine.length ? (found.size + right.size) / (song.length + mine.length) : 0;
    const late = bars.reduce((a, b) => a + b.late.length, 0);
    state.compare = { tab, score, bars, late, recall: found.size / (song.length || 1), precision: right.size / (mine.length || 1) };
    showCompare();
    return {
      score: +score.toFixed(3),
      recall: +state.compare.recall.toFixed(3),
      precision: +state.compare.precision.toFixed(3),
      songNotes: song.length,
      notJudged,
      wrongTime: late,
      tabNotes: mine.length,
      worst: worstBars(5).map((i) => ({ bar: i + 1, ...barSummary(bars[i]) })),
    };
  } finally {
    state.comparing = false;
    el.compare.disabled = false;
    el.compare.textContent = label;
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;
const names = (ps) => [...new Set(ps)].sort((a, b) => a - b).map(noteName).join(' ');

function barSummary(b) {
  return { score: b.score == null ? null : +b.score.toFixed(2), missing: names(b.missing), extra: names(b.extra), wrongTime: names(b.late) };
}

/** Bars that sound least like the song (with enough notes to judge), worst first. */
function worstBars(n) {
  const { bars } = state.compare;
  return bars
    .map((b, i) => i)
    .filter((i) => bars[i].score != null && bars[i].song + bars[i].tab >= 4)
    .sort((a, b) => bars[a].score - bars[b].score)
    .slice(0, n)
    .filter((i) => bars[i].score < MATCH.good);
}

/** Colour the bar numbers by how well each bar matches the song, and summarise it under the title. */
function showCompare() {
  const c = state.compare;
  if (!c || c.tab !== state.tab) {
    el.compareOut.hidden = true;
    return;
  }
  for (const sp of el.tab.querySelectorAll('.bar-no')) {
    const b = c.bars[+sp.dataset.bar];
    sp.classList.remove('good', 'ok', 'bad');
    if (!b || b.score == null) continue;
    sp.classList.add(b.score >= MATCH.good ? 'good' : b.score >= MATCH.ok ? 'ok' : 'bad');
    const s = barSummary(b);
    sp.title = `Bar ${+sp.dataset.bar + 1}: ${pct(b.score)} like the song` + (s.missing ? `\nmissing: ${s.missing}` : '') + (s.extra ? `\nnot in the song: ${s.extra}` : '') + (s.wrongTime ? `\nright note, wrong time: ${s.wrongTime}` : '');
  }
  const worst = worstBars(6);
  el.compareOut.innerHTML =
    `<b>Sounds like the song: ${pct(c.score)}</b> <span class="hint">(${pct(c.recall)} of the song's notes are in the tab, ${pct(c.precision)} of the tab's notes are in the song${c.late ? `; ${c.late} tab notes are right but off the beat` : ''})</span>` +
    (worst.length ? `<br>Least alike: ${worst.map((i) => `<a href="#" data-bar="${i}">bar ${i + 1}</a>`).join(', ')} <span class="hint">· hover a bar number for the notes</span>` : '');
  el.compareOut.hidden = false;
}

el.compare.addEventListener('click', () => compare().catch((err) => showError(err.message || String(err))));
el.compareOut.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-bar]');
  if (!a || !state.tab) return;
  e.preventDefault();
  const { q } = state.tab;
  el.audio.currentTime = Math.max(0, q.timeOf(q.barStarts[+a.dataset.bar]) - 0.05);
  highlight(el.audio.currentTime);
  state.cellsByIdx.get(q.barStarts[+a.dataset.bar])?.[0]?.closest('.system').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ---------- export ----------

function tabText() {
  const { measures, tuning, capo, tempo, sig, q } = state.tab;
  const header = [
    `Tuning: ${tuning.name}${capo ? `   Capo: ${capo}` : ''}   Tempo: ${tempo}   Time: ${sig}`,
    ...(q.columns.some((c) => c.tech?.some((t) => t && (t.bend || t.vibrato || t.link))) ? [TECH_LEGEND] : []),
    'Generated automatically by TabMaker from the audio. Check it by ear and fix by hand.',
  ].join('\n');
  return renderText(measures, tuning, { perRow: 4, title: state.title, header });
}

el.download.addEventListener('click', () => {
  if (!state.tab) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([tabText()], { type: 'text/plain' }));
  a.download = `${state.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) || 'tab'}.txt`;
  a.click();
});

el.copy.addEventListener('click', async () => {
  if (!state.tab) return;
  await navigator.clipboard.writeText(tabText());
  el.copy.textContent = 'Copied!';
  setTimeout(() => (el.copy.textContent = 'Copy text'), 1200);
});

// ---------- inputs ----------

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = el.url.value.trim();
  if (url) run(() => fromLink(url));
});

el.file.addEventListener('change', () => {
  const f = el.file.files[0];
  if (f) run(async () => ({ blob: f, title: f.name.replace(/\.[^.]+$/, '') }));
  el.file.value = '';
});

for (const input of [el.tuning, el.capo, el.mode, el.sens, el.minLen, el.minAmp, el.maxFret, el.grid, el.beats, el.bpm]) {
  input.addEventListener('input', () => {
    if (input === el.bpm) el.bpmAuto.checked = false;
    el.sensVal.textContent = el.sens.value;
    el.minAmpVal.textContent = `${el.minAmp.value}%`;
    retab();
  });
}
el.bpmAuto.addEventListener('change', retab);
el.handsMode.addEventListener('change', () => {
  el.fretboard.hidden = el.handsMode.value !== 'flat';
  el.handview.hidden = el.handsMode.value !== '3d';
  hv.key = null;
  fb.key = null;
  if (state.tab) highlight(el.audio.currentTime || 0);
});
el.clean.addEventListener('change', retab);
el.tech.addEventListener('change', retab);
el.relisten.addEventListener('click', async () => {
  if (!state.decoded) return;
  el.relisten.disabled = true;
  try {
    await listen();
  } catch (err) {
    showError(err.message);
  } finally {
    el.relisten.disabled = false;
  }
});
