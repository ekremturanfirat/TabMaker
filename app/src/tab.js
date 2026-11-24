// Turns detected notes into guitar tab: picks a string/fret for every note,
// keeps the fretting hand in one place where possible, and snaps to a beat grid.
// Strings are indexed 0 = low E ... 5 = high e.

export const TUNINGS = {
  standard: { name: 'Standard (E A D G B E)', notes: [40, 45, 50, 55, 59, 64], labels: ['E', 'A', 'D', 'G', 'B', 'e'] },
  dropD: { name: 'Drop D (D A D G B E)', notes: [38, 45, 50, 55, 59, 64], labels: ['D', 'A', 'D', 'G', 'B', 'e'] },
  halfDown: { name: 'Half step down (Eb)', notes: [39, 44, 49, 54, 58, 63], labels: ['Eb', 'Ab', 'Db', 'Gb', 'Bb', 'eb'] },
  fullDown: { name: 'Full step down (D G C F A D)', notes: [38, 43, 48, 53, 57, 62], labels: ['D', 'G', 'C', 'F', 'A', 'd'] },
  openG: { name: 'Open G (D G D G B D)', notes: [38, 43, 50, 55, 59, 62], labels: ['D', 'G', 'D', 'G', 'B', 'd'] },
  dadgad: { name: 'DADGAD', notes: [38, 45, 50, 55, 57, 62], labels: ['D', 'A', 'D', 'G', 'A', 'd'] },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (midi) => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
export const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** Lowest and highest playable MIDI pitch for a tuning/capo/max fret. */
export function playableRange(tuning, capo, maxFret) {
  return { low: Math.min(...tuning.notes) + capo, high: Math.max(...tuning.notes) + capo + maxFret };
}

// semitones above a sounding note -> how much quieter a detection must be to count as its overtone
const OVERTONES = { 12: 0.75, 19: 0.9, 24: 0.9, 28: 0.9, 31: 0.9 };
// A note with its own clear onset (the model heard it being struck) is played, even when it looks
// like an overtone or echo: e.g. a melody note an octave or a 12th above the bass.
const STRUCK = { together: 0.6, earlier: 0.65, echo: 0.7 };
// A note whose own pitch gets this much louder at its start (note.jump) was plucked, not just ringing
// on: never an echo, and never a faint ring-along note however soft. Ringing notes the model re-detects
// jump ~1-2x, real plucks ~10x or more.
const REPLUCK = 4;
const HABIT = { share: 0.5, min: 3, struck: 0.6, window: 5 }; // octave pairs: share of plucks, at least, onset of a real pluck, seconds around

/**
 * Drop detections that are not really played notes:
 *  - overtones (octave, 12th, 2 octaves… above a louder note that is sounding)
 *  - "echoes": a note still ringing that gets re-detected when a different note is picked
 *  - faint notes: quiet, with a weak onset and not plucked, e.g. open strings ringing along (faintOnset: the onset
 *    a note needs to be kept; the app raises it with the onset threshold so "Sensitivity" still works)
 * Notes need .onset (0–1) for the struck/faint checks and .jump (see REPLUCK) for the echo/faint
 * checks; without them they work as before. why: optional Map, filled with note -> rule that dropped it.
 */
export function removeGhostNotes(notes, { faintOnset = 0.6, why = null } = {}) {
  const sorted = [...notes].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  // An octave that comes with (nearly) every pluck of its note around this time is part of that
  // string's sound, not a played note (only octaves: a 12th above the bass is often really played,
  // e.g. F#2 + C#4 in a fingerstyle pattern). Counted over real plucks, not re-detected ringing notes.
  const struck = sorted.filter((m) => (m.onset ?? 1) >= HABIT.struck);
  const withOctave = new Set();
  for (let i = 0, j0 = 0; i < struck.length; i++) {
    const m = struck[i];
    while (sorted[j0].startTimeSeconds < m.startTimeSeconds - 0.05) j0++;
    for (let j = j0; j < sorted.length && sorted[j].startTimeSeconds <= m.startTimeSeconds + 0.05; j++) {
      const k = sorted[j].pitchMidi - m.pitchMidi;
      if ((k === 12 || k === 24) && sorted[j].amplitude < m.amplitude) withOctave.add(m);
    }
  }
  const habitual = (m) => {
    const t = m.startTimeSeconds;
    const near = struck.filter((x) => x.pitchMidi === m.pitchMidi && Math.abs(x.startTimeSeconds - t) <= HABIT.window);
    const n = near.filter((x) => withOctave.has(x)).length;
    return n >= HABIT.min && n / near.length >= HABIT.share;
  };
  const keep = [];
  let lo = 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const t = n.startTimeSeconds;
    while (sorted[lo].startTimeSeconds < t - 1.2) lo++;
    const together = [];
    const earlier = [];
    for (let j = lo; j < sorted.length && sorted[j].startTimeSeconds <= t + 0.05; j++) {
      const m = sorted[j];
      if (m === n) continue;
      if (Math.abs(m.startTimeSeconds - t) <= 0.05) together.push(m);
      else if (m.startTimeSeconds < t) earlier.push(m);
    }
    const recentlyStarted = (pitch) => earlier.some((e) => e.pitchMidi === pitch && t - e.startTimeSeconds <= 0.8);

    const isOvertoneOf = (m) => {
      const ratio = OVERTONES[n.pitchMidi - m.pitchMidi];
      return ratio && n.amplitude < ratio * m.amplitude;
    };
    const struck = n.onset ?? 0;
    const usual = together.some((m) => [12, 24].includes(n.pitchMidi - m.pitchMidi) && n.amplitude < m.amplitude && habitual(m));
    const overtone =
      usual || (struck < STRUCK.together && together.some(isOvertoneOf)) || (struck < STRUCK.earlier && earlier.some(isOvertoneOf));
    const echo =
      struck < STRUCK.echo &&
      !((n.jump ?? 0) >= REPLUCK) &&
      earlier.some((e) => e.pitchMidi === n.pitchMidi && t - e.startTimeSeconds <= 0.8 && e.amplitude >= 0.85 * n.amplitude) &&
      together.some((m) => !recentlyStarted(m.pitchMidi));
    const faint = n.onset != null && n.onset < faintOnset && n.amplitude < 0.45 && !((n.jump ?? 0) >= REPLUCK);
    if (!overtone && !echo && !faint) keep.push(n);
    else why?.set(n, overtone ? (usual ? 'usual' : 'overtone') : echo ? 'echo' : 'faint');
  }
  return keep;
}

/**
 * Group notes that start together into "events" (single notes or chords).
 * mode: 'full' keeps chords, 'melody' keeps the top note of each event,
 * 'bass' keeps the lowest.
 */
export function groupEvents(notes, { low, high, minAmp = 0, mode = 'full', window = 0.045, maxNotes = 6 }) {
  const usable = notes
    .filter((n) => n.pitchMidi >= low && n.pitchMidi <= high && n.amplitude >= minAmp)
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);

  const events = [];
  for (const n of usable) {
    const last = events[events.length - 1];
    // onset/attack (how hard it was picked), frame and bends (pitch curve) feed findTechniques
    const note = { pitch: n.pitchMidi, amp: n.amplitude, dur: n.durationSeconds, onset: n.onset ?? 1, attack: n.attack, frame: n.startFrame, bends: n.pitchBends };
    if (last && n.startTimeSeconds - last.time <= window) {
      const same = last.notes.find((m) => m.pitch === n.pitchMidi);
      if (same) same.amp = Math.max(same.amp, n.amplitude);
      else last.notes.push(note);
    } else {
      events.push({ time: n.startTimeSeconds, notes: [note] });
    }
  }

  for (const ev of events) {
    let ns = ev.notes;
    if (mode === 'melody') ns = [ns.reduce((a, b) => (b.pitch > a.pitch ? b : a))];
    else if (mode === 'bass') ns = [ns.reduce((a, b) => (b.pitch < a.pitch ? b : a))];
    else if (ns.length > maxNotes) ns = [...ns].sort((a, b) => b.amp - a.amp).slice(0, maxNotes);
    ev.notes = ns.sort((a, b) => b.pitch - a.pitch);
    ev.amp = Math.max(...ev.notes.map((n) => n.amp));
  }
  return events;
}

// ---------- playing techniques ----------
// h = hammer-on, p = pull-off, / \ = slide up/down, b = bend, r = release, ~ = vibrato.
// Legato notes (h, p, slides) follow a note that is still ringing and are not picked: no pick
// click in the audio (note.attack) and a weak model onset. Slides and bends also glide through the
// pitches in between. Bends and vibrato show up in the note's own pitch curve.
// Basic Pitch measures pitch in 1/3-semitone bins, ~86 frames a second.

const BINS_PER_SEMITONE = 3;
const pitchToBin = (midi) => (midi - 21) * BINS_PER_SEMITONE + 1; // an in-tune note peaks one bin above the formula

const TECH_LEVELS = {
  // picked: a model onset this strong means the note was struck, whatever the pick-click measure says
  // (the click gets lost when other strings ring loudly)
  clear: { attack: 1.6, onsetRatio: 0.5, onsetMax: 0.45, picked: 0.8, maxLegato: 4, glideFrames: 2, vibratoTurns: 5 },
  more: { attack: 2.5, onsetRatio: 0.8, onsetMax: 0.65, picked: Infinity, maxLegato: 5, glideFrames: 1, vibratoTurns: 3 },
};

/** A note's pitch curve in semitones (median-smoothed), or null if it jumps (another note got in). */
function pitchCurve(note) {
  const b = note.bends;
  if (!b || b.length < 5) return null;
  const med = b.map((_, i) => b.slice(Math.max(0, i - 1), i + 2).sort((x, y) => x - y)[1] ?? b[i]);
  for (let i = 1; i < med.length; i++) if (Math.abs(med[i] - med[i - 1]) > 2) return null;
  return med.map((v) => v / BINS_PER_SEMITONE);
}

/** Vibrato: the pitch wobbles up and down 3–14 times a second, several times in a row. */
function hasVibrato(curve, dur, lv) {
  if (dur < 0.25) return false;
  const fps = curve.length / dur;
  // take away the slow movement (bends) so only the wobble is left
  const wob = curve.map((v, i) => {
    const w = curve.slice(Math.max(0, i - 6), i + 7);
    return v - w.reduce((a, b) => a + b, 0) / w.length;
  });
  let sign = 0;
  let last = 0;
  let run = 0;
  let best = 0;
  wob.forEach((v, i) => {
    const s = v > 0.12 ? 1 : v < -0.12 ? -1 : 0;
    if (!s || s === sign) return;
    if (sign) {
      const half = (i - last) / fps;
      run = half >= 0.035 && half <= 0.17 ? run + 1 : 0;
      best = Math.max(best, run);
    }
    sign = s;
    last = i;
  });
  return best >= lv.vibratoTurns;
}

/** Bend inside one note: the pitch rises at least ~a semitone and stays up for a while. */
function findBend(curve, dur) {
  const fps = curve.length / dur;
  const base = Math.min(curve[0], curve[1], curve[2]);
  const peak = curve.reduce((bi, v, i) => (v > curve[bi] ? i : bi), 0);
  const rise = curve[peak] - base;
  if (rise < 0.8) return null;
  let run = 0;
  let held = 0;
  for (const v of curve) {
    run = v - base >= 0.7 * rise ? run + 1 : 0;
    held = Math.max(held, run);
  }
  if (held < 6) return null; // a wide vibrato goes up too, but not for long
  const at = curve.findIndex((v) => v - base >= rise / 2);
  const back = curve.findIndex((v, i) => i > peak && v - base <= 0.3);
  return { semis: Math.min(3, Math.round(rise)), at: at / fps, release: back > 0 ? back / fps : null };
}

/** How many frames just before note b's start sound strictly between pitches p1 and p2 (a slide or bend). */
function glideFrames(contours, p1, p2, frame) {
  const lo = Math.min(p1, p2);
  const hi = Math.max(p1, p2);
  const b0 = pitchToBin(lo);
  const b1 = pitchToBin(hi);
  let count = 0;
  for (let f = Math.max(0, frame - 15); f < Math.min(contours.length, frame + 4); f++) {
    const row = contours[f];
    let bi = b0;
    for (let b = b0; b <= b1; b++) if (row[b] > row[bi]) bi = b;
    if (row[bi] > 0.2 && bi > b0 && bi < b1) count++;
  }
  return count;
}

/**
 * How event `ev` follows `prev` without being picked: 'glide' (slide/bend), 'legato'
 * (hammer-on/pull-off), 'same' (the same note re-detected, e.g. during vibrato) or null.
 */
function joinKind(prev, ev, lv, contours) {
  const a = prev.notes[0];
  const b = ev.notes[0];
  const from = a.pitch + (prev.bend && prev.bend.release == null ? prev.bend.semis : 0);
  const d = Math.abs(b.pitch - from);
  if (d > 12 || prev.end < ev.time - 0.04) return null; // the first note must still be ringing
  if (d && contours && b.frame != null && glideFrames(contours, from, b.pitch, b.frame) >= lv.glideFrames) return 'glide';
  const soft = (b.attack ?? Infinity) < lv.attack || (b.onset < lv.onsetRatio * a.onset && b.onset < lv.onsetMax);
  if (!soft || b.onset >= lv.picked) return null;
  return !d ? 'same' : d <= lv.maxLegato ? 'legato' : null;
}

/**
 * Find playing techniques in single-note events (before fingering). Adds ev.bend {semis, at, release},
 * ev.vibrato and ev.link {kind, from}. A note bent up into the next one is merged into it as a bend.
 * level: 'off' | 'clear' | 'more'. contours: Basic Pitch's pitch contours (frames x bins).
 */
export function findTechniques(events, { level = 'clear', contours = null } = {}) {
  const lv = TECH_LEVELS[level];
  if (!lv) return events;
  const single = (ev) => ev.notes.length === 1;
  const out = [];
  for (const ev of events) {
    ev.end = ev.time + Math.max(...ev.notes.map((n) => n.dur));
    const curve = single(ev) && pitchCurve(ev.notes[0]);
    if (curve) {
      ev.vibrato = hasVibrato(curve, ev.notes[0].dur, lv);
      ev.bend = findBend(curve, ev.notes[0].dur);
    }
    const prev = out[out.length - 1];
    const kind = prev && single(prev) && single(ev) ? joinKind(prev, ev, lv, contours) : null;
    if (kind === 'glide' || kind === 'same') {
      const a = prev.notes[0].pitch;
      const b = ev.notes[0].pitch;
      const bent = prev.bend && prev.bend.release == null;
      if (kind === 'same') {
        // nothing to add: it's the same note still sounding
      } else if (!prev.bend && b > a && b - a <= 2) {
        prev.bend = { semis: b - a, at: ev.time - prev.time, release: null };
      } else if (bent && b === a) {
        prev.bend.release = ev.time - prev.time;
      } else {
        if (ev.notes[0].onset < lv.picked) ev.link = { kind, from: prev.time }; // a slide; a bend needs no such check
        out.push(ev);
        continue;
      }
      // merged into prev: one picked note that keeps sounding, bends (and maybe comes back down)
      prev.vibrato ||= ev.vibrato;
      prev.end = Math.max(prev.end, ev.end);
      continue;
    }
    if (kind) ev.link = { kind, from: prev.time };
    out.push(ev);
  }
  return out;
}

/** After fingering: per-string technique marks on each event (ev.tech[s] = {bend, vibrato, link, linked}). */
export function techniqueMarks(events) {
  const stringOf = (ev) => (ev.notes.length === 1 ? ev.frets.findIndex((f) => f >= 0) : -1);
  events.forEach((ev, i) => {
    const s = stringOf(ev);
    ev.tech = null;
    if (s < 0) return;
    const t = {};
    if (ev.bend && ev.frets[s] > 0) t.bend = ev.bend;
    if (ev.vibrato && ev.frets[s] > 0) t.vibrato = true;
    const prev = events[i - 1];
    // a slide needs a finger on the string at both ends: never from or to an open string
    const slide = ev.link?.kind === 'glide';
    if (ev.link && prev && prev.time === ev.link.from && prev.tech && stringOf(prev) === s && !(slide && (prev.frets[s] === 0 || ev.frets[s] === 0))) {
      const pt = prev.tech[s];
      const from = prev.frets[s] + (pt.bend && pt.bend.release == null ? pt.bend.semis : 0);
      const up = ev.frets[s] > from;
      pt.link = slide ? (up ? '/' : '\\') : up ? 'h' : 'p';
      t.linked = true;
    }
    ev.tech = [null, null, null, null, null, null];
    ev.tech[s] = t;
  });
  return events;
}

/** What a technique adds after the fret number: "b9r7~h". */
export function techText(fret, t) {
  if (!t) return '';
  let s = '';
  if (t.bend) s += `b${fret + t.bend.semis}${t.bend.release != null ? `r${fret}` : ''}`;
  if (t.vibrato) s += '~';
  return s + (t.link || '');
}

export const TECH_LEGEND = 'h hammer-on   p pull-off   / \\ slide up/down   b bend   r release   ~ vibrato';

/** Every way to put the given pitches on separate strings. Each result: frets[6] (-1 = not played). */
function fingerings(pitches, tuning, capo, maxFret) {
  const out = [];
  const frets = [-1, -1, -1, -1, -1, -1];
  const walk = (i) => {
    if (out.length > 400) return;
    if (i === pitches.length) {
      out.push(frets.slice());
      return;
    }
    for (let s = 0; s < 6; s++) {
      if (frets[s] !== -1) continue;
      const f = pitches[i] - tuning.notes[s] - capo;
      if (f < 0 || f > maxFret) continue;
      frets[s] = f;
      walk(i + 1);
      frets[s] = -1;
    }
  };
  walk(0);
  return out;
}

/** Fingerings for an event; if the notes can't all be played, drop the quietest until they can. */
function eventFingerings(ev, tuning, capo, maxFret) {
  let notes = ev.notes.slice();
  while (notes.length) {
    const fs = fingerings(notes.map((n) => n.pitch), tuning, capo, maxFret);
    const playable = fs.filter((f) => span(f) <= 5);
    if (playable.length) return playable;
    const quietest = notes.reduce((a, b) => (b.amp < a.amp ? b : a));
    notes = notes.filter((n) => n !== quietest);
  }
  return [];
}

function fretted(f) {
  return f.filter((x) => x > 0);
}
function span(f) {
  const fr = fretted(f);
  return fr.length ? Math.max(...fr) - Math.min(...fr) : 0;
}
/** How awkward a chord shape is regardless of where the hand is (which strings, how wide). */
function shapeCost(f) {
  const sp = span(f);
  let cost = sp * 0.3 + (sp > 3 ? (sp - 3) * 4 : 0);
  // prefer strings that sit next to each other (easier to strum/pick)
  const used = f.map((x, s) => (x >= 0 ? s : -1)).filter((s) => s >= 0);
  if (used.length > 1) cost += (used[used.length - 1] - used[0] - (used.length - 1)) * 0.8;
  return cost;
}

// The fretting hand: the index finger sits at fret `hand`, fingers 1-4 cover hand..hand+3
// (the pinky can stretch one more). Open strings need no finger and leave the hand free to move.
export const HAND = {
  posK: 0.05, pinky: 0.15, stretch: 2, shiftBase: 1, shiftPerFret: 0.5, speedOk: 12, sameFretK: 0.6,
  videoK: 5, videoSlack: 1, tipK: 1.5, tipFret: 0.9, tipString: 0.9,
};

// the strings across the board: about 43 mm from low E to high e at the nut, 57 at the 12th fret
const stringGap = (D) => (43 + 28 * D) / 5;
/** Which string a fingertip seen in the video is over (fractional, 0 = low E), for one camera side. */
const tipString = (tip, side) => 2.5 + (side * tip.v) / stringGap(tip.D);

/**
 * Cost of a fingering f held at h when the video shows the hand at hint.h (w: how sure it is).
 * The fingertip seen in the picture can be a fret off, so a fret either way is free; further is
 * expensive. With `side` known (see stringSide), every fretted note with no fingertip seen near its
 * string and fret costs too.
 */
function videoCost(f, h, hint, side) {
  if (!hint) return 0;
  let c = hint.w * HAND.videoK * Math.max(0, Math.abs(h - hint.h) - HAND.videoSlack);
  if (side && hint.tips.length >= 2) {
    f.forEach((fr, s) => {
      if (fr <= 0) return;
      // a pressing fingertip sits just behind its fret wire: fret fr - 0.3 or so
      const seen = hint.tips.some((t) => Math.abs(t.f - (fr - 0.3)) <= HAND.tipFret && Math.abs(tipString(t, side) - s) <= HAND.tipString);
      if (!seen) c += hint.w * HAND.tipK;
    });
  }
  return c;
}

/**
 * Which way the strings run across the picture: +1 or -1, or 0 if the video can't tell. The side
 * whose fingertips land on string/fret spots that play the notes heard (more often) is the right one.
 */
export function stringSide(events, tuning, capo, handAt) {
  if (!handAt) return 0;
  const score = { 1: 0, '-1': 0 };
  for (const ev of events) {
    const hint = handAt(ev.time);
    if (!hint || hint.tips.length < 2) continue;
    const pitches = new Set(ev.notes.map((n) => n.pitch));
    for (const side of [1, -1]) {
      for (const t of hint.tips) {
        const s = Math.round(tipString(t, side));
        if (s < 0 || s > 5) continue;
        const fr = Math.max(1, Math.round(t.f + 0.3));
        if (pitches.has(tuning.notes[s] + capo + fr)) score[side]++;
      }
    }
  }
  const total = score[1] + score[-1];
  if (total < 8 || Math.abs(score[1] - score[-1]) < 0.2 * total) return 0;
  return score[1] > score[-1] ? 1 : -1;
}

/**
 * Notes the hand can't reach where the video shows it (not open, not within its frets) are most
 * often heard an octave off (an overtone, or a low note heard high): move such a note an octave if
 * that lands under the hand, or drop it if that octave is already played. why (optional Map) gets
 * the reason for each changed note.
 */
export function fitNotesToHand(events, tuning, capo, maxFret, handAt, why = null) {
  if (!handAt) return events;
  return events.map((ev) => {
    const hint = handAt(ev.time);
    if (!hint || hint.w < 0.6) return ev;
    // Within reach: a fret either side of the four fingers. Checked against Nothing Else Matters'
    // on-screen tab, the notes this moves or drops are all overtones (B4 over open strings, D5 over
    // a 7th-position D chord), even where the fingers hover near the nut; a wider reach or skipping
    // hovering hands kept them. "Compare with the song" scores this a little lower, because the
    // song's own recording is heard with the same overtones.
    const lo = Math.max(1, hint.h - HAND.videoSlack);
    const hi = Math.min(maxFret, hint.h + 3 + HAND.videoSlack);
    const reach = (p) => tuning.notes.some((open) => {
      const fr = p - open - capo;
      return fr === 0 || (fr >= lo && fr <= hi);
    });
    const pitches = new Set(ev.notes.map((n) => n.pitch));
    let changed = false;
    const notes = [];
    for (const n of ev.notes) {
      if (reach(n.pitch)) {
        notes.push(n);
        continue;
      }
      const to = [n.pitch - 12, n.pitch + 12].find(reach);
      if (to == null) {
        notes.push(n);
        continue;
      }
      changed = true;
      why?.set(n, to < n.pitch ? 'video: an octave lower under the hand' : 'video: an octave higher under the hand');
      if (!pitches.has(to)) {
        notes.push({ ...n, pitch: to, videoOctave: to - n.pitch });
        pitches.add(to);
      }
    }
    return changed && notes.length ? { ...ev, notes } : ev;
  });
}

/** Hand positions (index-finger fret) that can play fingering f, with the cost of holding it there. */
function handOptions(f, maxFret) {
  const fr = fretted(f);
  const out = [];
  if (!fr.length) {
    for (let h = 1; h <= Math.max(1, maxFret - 3); h++) out.push({ h, c: 0 }); // open strings only: the hand can be anywhere
    return out;
  }
  const lo = Math.min(...fr);
  const hi = Math.max(...fr);
  for (let h = Math.max(1, hi - 4); h <= lo; h++) {
    let c = h * HAND.posK; // lower positions are a little easier
    for (const x of fr) {
      if (x - h === 3) c += HAND.pinky;
      if (x - h >= 4) c += HAND.stretch; // pinky stretch
    }
    // two notes on the same fret need one finger flattened across strings (fine for the index: barre)
    const byFret = {};
    for (const x of fr) byFret[x] = (byFret[x] || 0) + 1;
    for (const [x, n] of Object.entries(byFret)) if (n > 1 && +x !== h) c += (n - 1) * HAND.sameFretK;
    out.push({ h, c });
  }
  return out;
}

/** Cost of moving the hand from fret h1 to h2 in dt seconds: far and fast is hard. */
function shiftCost(h1, h2, dt) {
  const d = Math.abs(h1 - h2);
  if (!d) return 0;
  const speed = d / Math.max(dt, 0.04); // frets per second
  const rush = 1 + Math.max(0, speed - HAND.speedOk) / HAND.speedOk;
  const rest = dt > 1 ? 0.5 : 1; // long notes or rests give time to shift
  return (HAND.shiftBase + HAND.shiftPerFret * d) * rush * rest;
}

/** Fretting-hand fingers for a fingering at hand position h: -1 not played, 0 open, 1-4 finger. */
export function handFingers(frets, h) {
  return frets.map((f) => (f < 0 ? -1 : f === 0 ? 0 : Math.min(4, Math.max(1, f - h + 1))));
}

/**
 * Choose a fingering and hand position for every event with dynamic programming (Viterbi over
 * fingering x hand position) so the whole passage is comfortable to play: the hand stays in place
 * where it can and never has to jump far in a short time. Returns events with .frets, .hand
 * (index-finger fret) and .fingers (see handFingers) added.
 * handAt(time) (optional, from the player's video): {h, w}, where the player's hand was (h counted
 * from the capo) and how sure that is (0-1); the tab then keeps the hand there where it can.
 */
export function assignFrets(events, tuning, capo, maxFret, handAt = null) {
  const side = stringSide(events, tuning, capo, handAt);
  const states = events.map((ev) => {
    const bent = ev.bend || ev.vibrato; // can't bend or shake an open string
    const hint = handAt?.(ev.time);
    const fs = eventFingerings(ev, tuning, capo, maxFret)
      .map((f) => ({ f, c: shapeCost(f) + (bent && f.includes(0) ? 5 : 0) }))
      .sort((a, b) => a.c - b.c)
      .slice(0, hint ? 80 : 40); // the player's own shape may not be among the easiest few
    return fs.flatMap(({ f, c }) =>
      handOptions(f, maxFret).map((o) => ({ f, h: o.h, c: c + o.c + videoCost(f, o.h, hint, side), str: f.findIndex((x) => x >= 0) })));
  });

  let prev = null;
  const back = [];
  for (let i = 0; i < events.length; i++) {
    const cs = states[i];
    if (!cs.length) {
      back.push(null);
      continue;
    }
    const dt = prev ? events[i].time - events[prev.index].time : 0;
    // hammer-ons, pull-offs and slides only work on one string
    const linked = prev && events[i].link && prev.index === i - 1;
    const prevStates = prev ? states[prev.index] : null;
    const row = cs.map((c) => {
      if (!prev) return { total: c.c, from: -1 };
      let best = Infinity;
      let from = -1;
      prev.row.forEach((p, j) => {
        const ps = prevStates[j];
        const t = p.total + c.c + shiftCost(ps.h, c.h, dt) + (linked && ps.str !== c.str ? 4 : 0);
        if (t < best) {
          best = t;
          from = j;
        }
      });
      return { total: best, from };
    });
    back.push({ row, prevIndex: prev ? prev.index : -1 });
    prev = { row, index: i };
  }

  // trace back
  const choice = new Array(events.length).fill(null);
  if (prev) {
    let i = prev.index;
    let k = prev.row.reduce((bi, r, j, arr) => (r.total < arr[bi].total ? j : bi), 0);
    while (i >= 0 && back[i]) {
      choice[i] = states[i][k];
      const { row, prevIndex } = back[i];
      k = row[k].from;
      i = prevIndex;
    }
  }
  return events
    .map((ev, i) => (choice[i] ? { ...ev, frets: choice[i].f, hand: choice[i].h, fingers: handFingers(choice[i].f, choice[i].h) } : ev))
    .filter((ev) => ev.frets);
}

/** Estimate tempo (BPM) and beat phase from event onset times. */
export function estimateTempo(events) {
  const pts = events.map((e) => ({ t: e.time, w: 0.3 + e.amp }));
  if (pts.length < 4) return { bpm: 100, offset: events[0]?.time ?? 0 };
  const coherence = (period) => {
    let re = 0;
    let im = 0;
    let wsum = 0;
    for (const { t, w } of pts) {
      const a = (2 * Math.PI * t) / period;
      re += w * Math.cos(a);
      im += w * Math.sin(a);
      wsum += w;
    }
    return { mag: Math.hypot(re, im) / wsum, phase: Math.atan2(im, re) };
  };
  let best = { score: -1, bpm: 100, phase: 0 };
  for (let bpm = 60; bpm <= 190; bpm += 0.5) {
    const beat = 60 / bpm;
    const b = coherence(beat);
    const half = coherence(beat / 2);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.7, 2));
    const score = (b.mag + 0.5 * half.mag) * (0.6 + 0.4 * prior);
    if (score > best.score) best = { score, bpm, phase: b.phase };
  }
  const beat = 60 / best.bpm;
  let offset = ((best.phase / (2 * Math.PI)) * beat) % beat;
  if (offset < 0) offset += beat;
  // start the grid on the beat just before the first note
  const first = events[0].time;
  offset += Math.floor((first - offset) / beat) * beat;
  return { bpm: Math.round(best.bpm), offset: Math.max(0, offset) };
}

const BEAT = { tight: 100, jump: 4 }; // beat tracking: how steady the pulse stays; cost of re-syncing bar 1 (x mean accent)

/**
 * Beat tracking (dynamic programming, after Ellis 2007): beat times that land on the notes but keep
 * a steady pulse near `bpm`, so the beats follow a player who speeds up or slows down.
 * Returns beat times (seconds), from a beat before the first note to past the last one.
 */
export function trackBeats(events, { bpm }) {
  const FPS = 100;
  const beatSec = 60 / bpm;
  const period = beatSec * FPS;
  const t0 = events[0].time - beatSec;
  const n = Math.ceil((events[events.length - 1].time + 2 * beatSec - t0) * FPS);
  // onset strength over time: every note/chord is a bump, bass notes a bit more
  const env = new Float32Array(n);
  for (const ev of events) {
    const f = Math.round((ev.time - t0) * FPS);
    const w = 0.3 + ev.amp + (Math.min(...ev.notes.map((x) => x.pitch)) < 52 ? 0.5 : 0);
    for (let d = -3; d <= 3; d++) if (f + d >= 0 && f + d < n) env[f + d] += w * Math.exp((-d * d) / 4.5);
  }
  const mean = env.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(env.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  for (let i = 0; i < n; i++) env[i] /= sd;
  // best chain of beats ending at each frame; a gap far from one beat period costs more
  const minLag = Math.max(1, Math.round(period / 2));
  const maxLag = Math.round(period * 2);
  const pen = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) pen[lag] = BEAT.tight * Math.log(lag / period) ** 2;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    for (let lag = minLag; lag <= maxLag && lag <= t; lag++) {
      const v = score[t - lag] - pen[lag];
      if (v > best) {
        best = v;
        back[t] = t - lag;
      }
    }
    score[t] = env[t] + (best > -Infinity ? best : 0);
  }
  let t = n - 1;
  for (let i = Math.max(0, n - Math.round(period * 1.5)); i < n; i++) if (score[i] > score[t]) t = i;
  const frames = [];
  for (; t >= 0; t = back[t]) frames.push(t);
  const times = frames.reverse().map((f) => t0 + f / FPS);
  // too few notes to follow: a steady pulse at bpm
  return times.length >= 2 ? times : Array.from({ length: Math.max(2, Math.ceil(n / period)) }, (_, k) => t0 + k * beatSec);
}

/** Position of time t in beats (fractional), along tracked beat times; extends past both ends. */
function beatPosition(beats, t) {
  const last = beats.length - 1;
  if (t <= beats[0]) return (t - beats[0]) / (beats[1] - beats[0]);
  if (t >= beats[last]) return last + (t - beats[last]) / (beats[last] - beats[last - 1]);
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - beats[lo]) / (beats[lo + 1] - beats[lo]);
}

/** Time of a (fractional) beat position: the inverse of beatPosition. */
function beatTime(beats, pos) {
  const last = beats.length - 1;
  const k = Math.min(Math.max(Math.floor(pos), 0), last - 1);
  return beats[k] + (pos - k) * (beats[k + 1] - beats[k]);
}

/**
 * Guess the time signature (3/4, 4/4 or 6/8 in eighths, or one of `choices`) and which beats start a bar. Beat 1 of
 * a bar gets the accents: bass notes, chords and loud notes. The bar count follows the music: where
 * the accents move (a bar with a beat more or less, a pause), bar 1 is found again.
 * bpm: the song's overall tempo (for telling 3/4 from 4/4).
 * Returns { beats: beats per bar, starts: beat indices that start a bar, jumps: how often it re-synced,
 * six: what decided 3/4 vs 6/8 (or null) }.
 */
export function findBars(events, beats, { choices = [4, 3], bpm }) {
  const acc = new Array(beats.length).fill(0);
  const bassAt = new Array(beats.length).fill(0);
  for (const ev of events) {
    const pos = beatPosition(beats, ev.time);
    const k = Math.round(pos);
    if (k < 0 || k >= beats.length || Math.abs(pos - k) > 0.25) continue; // off-beat note
    const bass = Math.min(...ev.notes.map((n) => n.pitch)) < 52 ? 1 : 0;
    acc[k] += ev.amp * (1 + 0.3 * (ev.notes.length - 1)) + bass;
    bassAt[k] += bass;
  }
  const mean = acc.reduce((a, b) => a + b, 0) / acc.length || 1;
  const jump = BEAT.jump * mean;

  /** Which beat of an m-beat bar each beat is (Viterbi): counting on is free, re-syncing costs `jump`. */
  const count = (m) => {
    // beat 1 should be accented; bass breaks near-ties (beats 1 and 4 of a 6/8 bar are both strong)
    const gain = (k, p) => (p === 0 ? acc[k] - mean + 0.25 * bassAt[k] : 0);
    let prev = Array.from({ length: m }, (_, p) => gain(0, p));
    const from = [new Array(m).fill(-1)];
    for (let k = 1; k < beats.length; k++) {
      const cur = new Array(m);
      const f = new Array(m);
      for (let p = 0; p < m; p++) {
        const q = (p + m - 1) % m; // counting on from the previous beat
        let best = prev[q];
        f[p] = q;
        for (let r = 0; r < m; r++) {
          if (r !== q && prev[r] - jump > best) {
            best = prev[r] - jump;
            f[p] = r;
          }
        }
        cur[p] = best + gain(k, p);
      }
      from.push(f);
      prev = cur;
    }
    let p = prev.indexOf(Math.max(...prev));
    const pos = new Array(beats.length);
    for (let k = beats.length - 1; k >= 0; k--) {
      pos[k] = p;
      p = from[k][p];
    }
    const starts = [];
    let jumps = 0;
    pos.forEach((x, k) => {
      if (x === 0) starts.push(k);
      if (k > 0 && x !== (pos[k - 1] + 1) % m) jumps++;
    });
    // how much stronger beat 1 is than an average beat (re-syncs pay their cost)
    const contrast = starts.length ? (starts.reduce((a, k) => a + acc[k], 0) - jumps * jump) / starts.length / mean : 0;
    return { beats: m, starts, jumps, contrast };
  };

  if (choices.length === 1) return count(choices[0]);

  // Time signature: the bar length that puts the strongest accents on beat 1, measured on a steady
  // pulse at `bpm` over the whole song. (On the tracked beats a 4-beat count can chase accents
  // through re-syncs almost as well as the right one; one steady phase can't, so it tells them apart.)
  const beat = 60 / bpm;
  let re = 0;
  let im = 0;
  for (const ev of events) {
    const a = (2 * Math.PI * ev.time) / beat;
    re += (0.3 + ev.amp) * Math.cos(a);
    im += (0.3 + ev.amp) * Math.sin(a);
  }
  const phase0 = (Math.atan2(im, re) / (2 * Math.PI)) * beat;
  const steady = new Map();
  const steadyBass = new Map(); // bass notes that were struck (not a ringing bass heard again)
  for (const ev of events) {
    const k = Math.round((ev.time - phase0) / beat);
    if (Math.abs(ev.time - phase0 - k * beat) > beat / 4) continue; // off-beat note
    const low = ev.notes.reduce((a, b) => (b.pitch < a.pitch ? b : a));
    const bass = low.pitch < 52 ? 1 : 0;
    steady.set(k, (steady.get(k) || 0) + ev.amp * (1 + 0.3 * (ev.notes.length - 1)) + bass);
    if (bass && low.onset >= SIX.struck) steadyBass.set(k, (steadyBass.get(k) || 0) + 1);
  }
  const k0 = Math.min(...steady.keys());
  const s = Array.from({ length: Math.max(...steady.keys()) - k0 + 1 }, (_, i) => steady.get(k0 + i) || 0);
  const sMean = s.reduce((a, b) => a + b, 0) / s.length || 1;
  // how often the bass is struck on each beat of an m-beat cycle, and how far the most common beat leads
  const bassProfile = (m) => Array.from({ length: m }, (_, p) => {
    let sum = 0;
    let n = 0;
    for (let k = p; k < s.length; k += m) {
      sum += steadyBass.get(k0 + k) || 0;
      n++;
    }
    return n ? sum / n : 0;
  });
  const lead = (prof) => {
    const p = prof.indexOf(Math.max(...prof));
    return prof[p] / (Math.max(...prof.filter((_, q) => q !== p)) || 1e-9);
  };
  const tops = {};
  let beatsPerBar = choices[0];
  let bestContrast = 0;
  for (const m of choices.filter((c) => c !== 6)) {
    let top = 0;
    for (let p = 0; p < m; p++) {
      let sum = 0;
      let n = 0;
      for (let k = p; k < s.length; k += m) {
        sum += s[k];
        n++;
      }
      top = Math.max(top, n ? sum / n / sMean : 0);
    }
    tops[m] = top;
    // 3/4 must win clearly: in 4/4 beat 3 is strong too, which also weakens a 4-beat pattern
    if (top > bestContrast * (m === 3 ? 1.08 : 1)) {
      bestContrast = top;
      beatsPerBar = m;
    }
  }
  // A waltz whose chords ring as loud as its bass looks like 4/4 to the accents, but its bass is
  // struck on one beat of every three far more than on the others (in 4/4 it comes every two or four)
  const bass3 = lead(bassProfile(3));
  const bass4 = lead(bassProfile(4));
  if (beatsPerBar === 4 && choices.includes(3) && bass3 >= TRIPLE.lead && bass3 >= TRIPLE.over4 * bass4) beatsPerBar = 3;
  // 6/8 counted in eighths: the bass is struck on one beat of every six far more than on any other
  // (in 3/4 it comes every three beats, in 4/4 every two or four), and the notes hardly ever split a
  // beat (the beats are eighths, not quarters with eighths in between).
  let six = null;
  if (choices.includes(6)) {
    six = { ratio: lead(bassProfile(6)), split: subdivision(events, beats).half };
    // already triple: 3/4 or 6/8 only differ in how the threes group; otherwise it must be clear
    if (six.ratio >= (beatsPerBar === 3 ? SIX.triple : SIX.ratio) && six.split <= SIX.split) beatsPerBar = 6;
  }
  const why = { tops, bass3, bass4, six };
  return { ...count(beatsPerBar), six, why };
}

// 6/8: how much more often the bass is struck on beat 1 of six than on the next most common beat, at
// least (triple: when the accents already say 3/4); share of notes between beats, at most; the onset
// a bass note needs to count as struck
const SIX = { ratio: 1.6, triple: 1.3, split: 0.18, struck: 0.5 };
// 3/4 over 4/4 by the bass: how far the most common beat of three leads the next, at least, and how much
// more than the lead over four beats (waltzes 1.5-4.8; 4/4 songs up to 1.1)
const TRIPLE = { lead: 1.45, over4: 1.2 };
const TERNARY = { third: 0.15, overHalf: 1.5 }; // beats split in three: share of notes on the thirds, and how much more than on the half

/** Share of notes on the beat, halfway, and on the thirds of the beat. */
function subdivision(events, beats) {
  let on = 0;
  let half = 0;
  let third = 0;
  for (const ev of events) {
    const p = beatPosition(beats, ev.time);
    const f = p - Math.floor(p);
    if (f < 0.07 || f > 0.93) on++;
    else if (Math.abs(f - 0.5) < 0.07) half++;
    else if (Math.abs(f - 1 / 3) < 0.07 || Math.abs(f - 2 / 3) < 0.07) third++;
  }
  const n = events.length || 1;
  return { on: on / n, half: half / n, third: third / n };
}

/**
 * A tracked beat that the notes split in three: a dotted quarter of 6/8, or a quarter played in triplets.
 * Returns the beats cut in three (the eighths of 6/8), or null.
 */
export function splitBeats(events, beats) {
  const sub = subdivision(events, beats);
  if (sub.third < TERNARY.third || sub.third < TERNARY.overHalf * sub.half) return null;
  const out = [];
  for (let k = 0; k + 1 < beats.length; k++) for (let j = 0; j < 3; j++) out.push(beats[k] + ((beats[k + 1] - beats[k]) * j) / 3);
  out.push(beats[beats.length - 1]);
  return out;
}

/**
 * Snap events onto a grid along the tracked beats. grid = steps per beat (2 = eighths, 4 = sixteenths).
 * bars: beat indices that start a bar (notes before the first form a pickup bar).
 * Returns { columns: [{idx, time, frets, tech, hand, fingers}], barStarts (grid steps), stepsPerMeasure
 * (a usual bar), timeOf(idx), idxOf(time) }.
 */
export function quantize(events, { beats, bars, grid = 4, beatsPerBar = 4 }) {
  const idxOf = (t) => Math.round(beatPosition(beats, t) * grid);
  const timeOf = (idx) => beatTime(beats, idx / grid);
  const cols = new Map();
  let lastIdx = -1;
  for (const ev of events) {
    let idx = Math.max(0, idxOf(ev.time));
    const existing = cols.get(idx);
    if (existing && existing.frets.every((f, s) => f < 0 || ev.frets[s] < 0)) {
      ev.frets.forEach((f, s) => f >= 0 && ((existing.frets[s] = f), existing.fingers && (existing.fingers[s] = ev.fingers?.[s] ?? -1))); // merge a late chord tone
      if (ev.tech) existing.tech = existing.frets.map((_, s) => ev.tech[s] || existing.tech?.[s] || null);
      continue;
    }
    if (idx <= lastIdx) idx = lastIdx + 1;
    cols.set(idx, { idx, time: ev.time, frets: ev.frets.slice(), tech: ev.tech || null, hand: ev.hand, fingers: ev.fingers?.slice() });
    lastIdx = idx;
  }
  // notes before the first downbeat make a pickup bar; without any, the tab starts on bar 1
  const columns = [...cols.values()];
  const first = bars.length ? bars[0] * grid : 0;
  const pickup = !bars.length || columns.some((c) => c.idx < first) ? [0] : [];
  const barStarts = [...new Set([...pickup, ...bars.map((b) => b * grid)])].filter((i) => i <= Math.max(lastIdx, 0)).sort((a, b) => a - b);
  return { columns, barStarts, stepsPerMeasure: grid * beatsPerBar, grid, timeOf, idxOf };
}

/** Build the measures: measures[m][step] = column {frets, tech, ...} or null. Bars can differ in length. */
export function toMeasures(q) {
  const lastIdx = q.columns.length ? q.columns[q.columns.length - 1].idx : 0;
  const starts = q.barStarts;
  const lastStart = starts[starts.length - 1];
  const end = Math.max(lastIdx + 1, lastStart + q.stepsPerMeasure);
  const measures = starts.map((s, m) => new Array((starts[m + 1] ?? end) - s).fill(null));
  let m = 0;
  for (const c of q.columns) {
    while (m + 1 < starts.length && starts[m + 1] <= c.idx) m++;
    measures[m][c.idx - starts[m]] = c;
  }
  return measures;
}

/** Plain-text tab (high e on top), `perRow` measures per line. */
export function renderText(measures, tuning, { perRow = 4, title = '', header = '' } = {}) {
  const labelW = Math.max(...tuning.labels.map((l) => l.length));
  const lines = [];
  if (title) lines.push(title, '');
  if (header) lines.push(header, '');
  for (let r = 0; r < measures.length; r += perRow) {
    const row = measures.slice(r, r + perRow);
    lines.push(' '.repeat(labelW + 1) + row.map((m, i) => String(r + i + 1).padEnd(measureWidth(m) + 1)).join(''));
    for (let s = 5; s >= 0; s--) {
      let line = tuning.labels[s].padEnd(labelW) + '|';
      for (const m of row) line += measureString(m, s) + '|';
      lines.push(line);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Fret number plus technique marks for string s of a column ('' if the string isn't played). */
export function noteText(col, s) {
  const f = col ? col.frets[s] : -1;
  return f >= 0 ? String(f) + techText(f, col.tech?.[s]) : '';
}
export function cellWidth(col) {
  return col ? Math.max(2, ...col.frets.map((_, s) => noteText(col, s).length + 1)) : 2;
}
function measureWidth(m) {
  return m.reduce((w, c) => w + cellWidth(c), 0);
}
export function cellString(col, s) {
  return noteText(col, s).padEnd(cellWidth(col), '-');
}
function measureString(m, s) {
  return m.map((c) => cellString(c, s)).join('');
}
