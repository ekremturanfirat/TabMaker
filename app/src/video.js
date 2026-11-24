// The video of the player, next to the tab. The sound alone can't tell which string a note was
// played on; the picture can: you mark the neck once (two or three fret wires), a hand model finds
// the fretting hand in every frame, and the tab then keeps the hand where the player had it.
//
// Neck marks: you click both ends of two fret wires (the nut and the 12th, say). A fret wire's
// distance from the nut is a share of the scale, D(f) = 1 - 2^(-f/12), and the fretboard widens a
// little towards the body; so the four ends are four known points of the fretboard's plane, which
// fix the perspective (a homography) between the fretboard and the picture. Then any fingertip in
// the picture maps back to a fret and to a place across the strings. More wires refine it.
// A cut to another camera angle breaks the marks: frames are compared as tiny grey thumbnails, and
// marks hold for their own shot and for later shots that look the same (the camera came back).

const STEP = 0.25; // s between frames looked at
const NEAR = 0.35; // s: hand frames this close to a note count for it
const CUT = 26; // mean grey-level change (0-255) of a 32x18 thumbnail that means a new shot
const SAME_SHOT = 18; // ...and the most a shot may differ from a marked one to reuse its marks
const TIPS = [8, 12, 16, 20]; // hand-model points: index, middle, ring, pinky fingertips
const PAD = 0.35; // where the finger presses, from its tip towards its last joint
const MAX_HAND_FRET = 17; // a hand whose fingers sit further up is the plucking hand over the sound hole

const dist = (f) => 1 - 2 ** (-f / 12);
const fretAt = (D) => (D >= 0.999 ? 99 : -12 * Math.log2(1 - D));

// the fretboard in mm: u along the strings from the nut, v across (0 = middle); it widens from
// about 52 mm at the nut to 62 at the 12th fret (classical; steel-string necks are a little narrower)
const SCALE = 650;
const halfWidth = (D) => 26 + 10 * D;

/**
 * Fit the neck from marks [{fret, a: [x, y], b: [x, y]}]: both ends of fret wires, video pixels.
 * Returns the neck (see below) or null if the marks don't make one (fewer than two wires, too close).
 */
export function neckFromMarks(marks) {
  const ms = [...marks].filter((m) => m.a && m.b).sort((p, q) => p.fret - q.fret);
  if (ms.length < 2 || ms[0].fret === ms[ms.length - 1].fret) return null;
  // the same side of every wire: the end nearer the first wire's "a" end
  const ref = ms[0];
  const pairs = [];
  for (const m of ms) {
    const flip = m !== ref && Math.hypot(m.b[0] - ref.a[0], m.b[1] - ref.a[1]) + Math.hypot(m.a[0] - ref.b[0], m.a[1] - ref.b[1]) <
      Math.hypot(m.a[0] - ref.a[0], m.a[1] - ref.a[1]) + Math.hypot(m.b[0] - ref.b[0], m.b[1] - ref.b[1]);
    const [p, q] = flip ? [m.b, m.a] : [m.a, m.b];
    const D = dist(m.fret);
    pairs.push([[SCALE * D, -halfWidth(D)], p], [[SCALE * D, halfWidth(D)], q]);
  }
  const H = homography(pairs);
  if (!H) return null;
  const Hi = invert3(H);
  if (!Hi) return null;
  const toImage = (u, v) => apply(H, u, v);
  const toNeck = (x, y) => {
    const [u, v] = apply(Hi, x, y);
    return { D: u / SCALE, v };
  };
  // sanity: the 12th fret wire must not land on the nut, and nothing may fold over
  const [nx, ny] = toImage(0, 0);
  const [tx, ty] = toImage(SCALE / 2, 0);
  if (!(Math.hypot(tx - nx, ty - ny) > 10)) return null;
  return {
    marks: ms,
    toNeck,
    /** image point of fret wire f, `side` from -1 (one edge of the fretboard) to 1 (the other) */
    point: (f, side = 0) => toImage(SCALE * dist(f), side * halfWidth(dist(f))),
    fretOf: (x, y) => fretAt(toNeck(x, y).D),
  };
}

/** Homography (3x3, h33 = 1) from >= 4 pairs [[u, v], [x, y]] by least squares (DLT). */
function homography(pairs) {
  const A = [];
  const b = [];
  for (const [[u, v], [x, y]] of pairs) {
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  // normal equations, solved by Gaussian elimination with pivoting
  const n = 8;
  const M = Array.from({ length: n }, (_, i) => [...Array.from({ length: n }, (_, j) => A.reduce((t, r) => t + r[i] * r[j], 0)), A.reduce((t, r, k) => t + r[i] * b[k], 0)]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const h = M.map((row, i) => row[n] / row[i]);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

function apply(H, u, v) {
  const w = H[2][0] * u + H[2][1] * v + H[2][2];
  return [(H[0][0] * u + H[0][1] * v + H[0][2]) / w, (H[1][0] * u + H[1][1] * v + H[1][2]) / w];
}

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/**
 * The fretting hand in one frame: hands = [[[x, y], ... 21 points], ...] in video pixels.
 * Returns {h, tips} (h = fret under the lowest fingertip on the neck, 0 = at the nut) or null.
 */
export function fretHand(hands, neck) {
  let best = null;
  for (const lm of hands) {
    const tips = TIPS.map((i) => {
      // the finger presses with its pad, a little back from the very tip towards the last joint
      // (the model's point i - 1): the fingers arch over from the treble side, so the tip itself
      // overshoots the string by most of a string's spacing
      const x = lm[i][0] + PAD * (lm[i - 1][0] - lm[i][0]);
      const y = lm[i][1] + PAD * (lm[i - 1][1] - lm[i][1]);
      const { D, v } = neck.toNeck(x, y);
      // a pressing fingertip sits on a string; seen from the side it can look a little off the board
      const on = D > -0.04 && D < 0.75 && Math.abs(v) < halfWidth(D) * 1.6;
      return { x, y, f: fretAt(D), D, v, on };
    });
    const on = tips.filter((t) => t.on);
    if (on.length < 2) continue;
    const fs = on.map((t) => t.f).sort((a, b) => a - b);
    const mid = fs[Math.floor(fs.length / 2)];
    if (mid > MAX_HAND_FRET) continue;
    if (!best || on.length > best.n || (on.length === best.n && mid < best.mid)) {
      best = { n: on.length, mid, h: Math.max(0, Math.ceil(fs[0])), tips };
    }
  }
  return best && { h: best.h, tips: best.tips };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function thumbDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

function seek(v, t) {
  return new Promise((ok) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(timer);
      ok();
    };
    const timer = setTimeout(done, 4000);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}

let landmarker = null;
async function getLandmarker() {
  if (landmarker) return landmarker;
  const base = new URL('mediapipe/', import.meta.url).href;
  const url = `${base}vision_bundle.mjs`;
  const vision = await import(url); // a separate file, loaded only when the hand is followed
  const files = await vision.FilesetResolver.forVisionTasks(`${base}wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: `${base}hand_landmarker.task`, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.4,
    minHandPresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });
  try {
    landmarker = await vision.HandLandmarker.createFromOptions(files, opts('GPU'));
  } catch {
    landmarker = await vision.HandLandmarker.createFromOptions(files, opts('CPU'));
  }
  return landmarker;
}

/**
 * The video panel. box: an empty element. audio: the song's <audio>. capo: the capo <input>.
 * tabHandAt(t): where the tab puts the index finger at time t (fret from the nut) or null.
 * onChange(): the hand data or marks changed, so the tab should be made again.
 */
export function createVideoPanel({ box, audio, capo, tabHandAt, onChange }) {
  box.innerHTML = `
    <div class="vp-stage">
      <video class="vp-video" muted playsinline preload="auto"></video>
      <canvas class="vp-over"></canvas>
    </div>
    <div class="vp-bar">
      <button type="button" class="vp-mark">Mark the neck</button>
      <label class="vp-fretlab" hidden>fret wire <input class="vp-fret" type="number" min="0" max="22" value="0"></label>
      <button type="button" class="vp-done" hidden>Done</button>
      <button type="button" class="vp-clear" hidden>Clear marks</button>
      <label>capo at fret <input class="vp-capo" type="number" min="0" max="12" value="0"></label>
      <button type="button" class="vp-track" disabled>Follow the hand</button>
      <label class="vp-uselab" hidden><input class="vp-use" type="checkbox" checked> tab follows the video</label>
    </div>
    <div class="vp-msg hint"></div>`;
  const q = (c) => box.querySelector(c);
  const v = q('.vp-video');
  const cv = q('.vp-over');
  const ui = {
    mark: q('.vp-mark'), fretLab: q('.vp-fretlab'), fret: q('.vp-fret'), done: q('.vp-done'), clear: q('.vp-clear'),
    capo: q('.vp-capo'), track: q('.vp-track'), useLab: q('.vp-uselab'), use: q('.vp-use'), msg: q('.vp-msg'),
  };

  const st = {
    src: null,
    marking: false,
    marks: [], // being placed now
    necks: [], // {time, thumb, neck}
    samples: [], // {t, hands, thumb, shot}
    shots: [], // {start, thumb}
    tracking: false,
    hints: null, // [{t, h}] once followed
  };

  const say = (text) => (ui.msg.textContent = text);

  // ---------- loading and sync ----------

  function load(blob) {
    if (st.src) URL.revokeObjectURL(st.src);
    Object.assign(st, { src: null, marking: false, marks: [], necks: [], samples: [], shots: [], hints: null });
    ui.use.checked = true;
    ui.useLab.hidden = true;
    if (!blob) {
      box.hidden = true;
      v.removeAttribute('src');
      v.load(); // let go of the old video
      return;
    }
    st.src = URL.createObjectURL(blob);
    v.src = st.src;
    box.hidden = false;
    ui.capo.value = capo.value || 0;
    showButtons();
    say('The player’s video. Mark the neck so TabMaker can read where the fretting hand is: pause on a clear view of the neck and press "Mark the neck".');
  }

  function unavailable(why) {
    load(null);
    console.info('No video:', why);
  }

  const sync = () => {
    if (!st.src || st.marking) return;
    if (Math.abs(v.currentTime - audio.currentTime) > 0.15) v.currentTime = audio.currentTime;
  };
  audio.addEventListener('play', () => {
    if (!st.src) return;
    sync();
    v.play().catch(() => {});
    tick();
  });
  audio.addEventListener('pause', () => v.pause());
  audio.addEventListener('seeked', sync);
  audio.addEventListener('timeupdate', () => {
    sync();
    if (audio.paused) draw();
  });
  v.addEventListener('loadeddata', draw);
  v.addEventListener('seeked', draw);
  window.addEventListener('resize', draw);
  function tick() {
    draw();
    if (!audio.paused) requestAnimationFrame(tick);
  }

  // ---------- neck marks ----------

  function showButtons() {
    ui.fretLab.hidden = !st.marking;
    ui.done.hidden = !st.marking;
    ui.mark.hidden = st.marking;
    ui.clear.hidden = st.marking || !st.necks.length;
    ui.track.disabled = st.marking || !st.necks.length || st.tracking;
  }

  ui.mark.addEventListener('click', () => {
    audio.pause();
    st.marking = true;
    st.marks = [];
    ui.fret.value = 0;
    showButtons();
    say('Click one end of the nut (where the strings leave the headstock), then its other end. If the nut is out of the picture, first type the number of a fret wire you can see, then click its two ends.');
    draw();
  });

  cv.addEventListener('click', (e) => {
    if (!st.marking || !v.videoWidth) return;
    const r = cv.getBoundingClientRect();
    const k = v.videoWidth / r.width;
    const p = [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
    const open = st.marks.find((m) => !m.b);
    if (open) {
      open.b = p; // the wire's other end
      const wires = st.marks.length;
      if (wires === 1) {
        ui.fret.value = open.fret < 12 ? 12 : Math.max(0, open.fret - 5);
        say('Now type the number of another fret wire far from it (12 is good) and click its two ends.');
      } else {
        ui.fret.value = 5;
        say(wires === 2
          ? 'The blue lines should now sit on the fret wires. If some drift, click both ends of one more wire (type its number first). Then press "Done".'
          : 'Press "Done" when the lines sit on the fret wires, or mark more wires to fix them.');
      }
    } else {
      const fret = Math.max(0, Math.min(22, Math.round(+ui.fret.value || 0)));
      st.marks = st.marks.filter((m) => m.fret !== fret);
      st.marks.push({ fret, a: p });
      say(`Now click the other end of ${fret ? `fret wire ${fret}` : 'the nut'}.`);
    }
    draw();
  });

  ui.done.addEventListener('click', () => {
    const neck = neckFromMarks(st.marks);
    st.marking = false;
    if (neck) {
      st.necks.push({ time: v.currentTime, thumb: thumbOf(v), neck });
      say(st.samples.length
        ? 'Marked. The hand positions are read again with the new marks.'
        : 'Marked. Set the capo if there is one (the orange line), then press "Follow the hand".');
      if (st.samples.length) refreshHints();
    } else {
      say('Those marks don’t make a neck: click both ends of two different fret wires, not too close together.');
    }
    st.marks = [];
    showButtons();
    draw();
  });

  ui.clear.addEventListener('click', () => {
    st.necks = [];
    st.hints = null;
    ui.useLab.hidden = true;
    showButtons();
    draw();
    onChange();
  });

  ui.capo.addEventListener('input', () => {
    capo.value = ui.capo.value;
    capo.dispatchEvent(new Event('input')); // the tab follows the capo like the Options field
    draw();
  });
  capo.addEventListener('input', () => {
    if (ui.capo.value !== capo.value) ui.capo.value = capo.value;
  });

  ui.use.addEventListener('change', onChange);

  // ---------- which marks hold for a frame ----------

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 32;
  thumbCanvas.height = 18;
  const tctx = thumbCanvas.getContext('2d', { willReadFrequently: true });
  function thumbOf(video) {
    tctx.drawImage(video, 0, 0, 32, 18);
    const px = tctx.getImageData(0, 0, 32, 18).data;
    const g = new Float32Array(32 * 18);
    for (let i = 0; i < g.length; i++) g[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    return g;
  }

  /** The marks for time t (or for a frame's thumbnail): same shot, or a shot that looks the same. */
  function neckFor(t, thumb) {
    if (!st.necks.length) return null;
    if (!st.shots.length) return st.necks[st.necks.length - 1].neck; // shots unknown before following the hand
    const shotAt = (time) => {
      let k = 0;
      while (k + 1 < st.shots.length && st.shots[k + 1].start <= time + 1e-6) k++;
      return k;
    };
    const s = shotAt(t);
    let best = null;
    for (const n of st.necks) {
      if (shotAt(n.time) === s) return n.neck;
      const d = thumbDiff(thumb || st.shots[s].thumb, n.thumb);
      if (d < SAME_SHOT && (!best || d < best.d)) best = { d, neck: n.neck };
    }
    return best?.neck ?? null;
  }

  // ---------- following the hand ----------

  ui.track.addEventListener('click', () => follow());

  async function follow() {
    const from = Math.max(0, tabRange().from);
    const to = Math.min(v.duration || 0, tabRange().to);
    if (!(to > from)) return;
    st.tracking = true;
    showButtons();
    say('Loading the hand model…');
    try {
      const lm = await getLandmarker();
      const w = document.createElement('video');
      w.muted = true;
      w.preload = 'auto';
      w.src = st.src;
      await new Promise((ok, bad) => {
        w.addEventListener('loadeddata', ok, { once: true });
        w.addEventListener('error', () => bad(new Error('The video can’t be decoded.')), { once: true });
      });
      const samples = [];
      const shots = [];
      let prev = null;
      let stamp = performance.now();
      for (let t = from; t <= to; t += STEP) {
        await seek(w, t);
        const thumb = thumbOf(w);
        if (!prev || thumbDiff(thumb, prev) > CUT) shots.push({ start: t, thumb });
        prev = thumb;
        stamp = Math.max(stamp + 1, performance.now());
        const res = lm.detectForVideo(w, stamp);
        const hands = (res.landmarks || []).map((pts) => pts.map((p) => [p.x * w.videoWidth, p.y * w.videoHeight]));
        samples.push({ t, hands, thumb });
        if (samples.length % 8 === 0) {
          say(`Following the hand… ${Math.round(((t - from) / (to - from)) * 100)}%`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      w.removeAttribute('src');
      st.samples = samples;
      st.shots = shots;
      refreshHints();
    } catch (err) {
      console.error(err);
      say(`Couldn’t follow the hand: ${err.message || err}`);
    } finally {
      st.tracking = false;
      showButtons();
    }
  }

  let tabRange = () => ({ from: 0, to: Infinity });

  function refreshHints() {
    st.hints = st.samples.map((s) => {
      const neck = neckFor(s.t, s.thumb);
      const hand = neck && fretHand(s.hands, neck);
      // the fingertips on the board: fret (from the nut, fractional) and mm across from the middle
      const tips = hand ? hand.tips.filter((p) => p.on).map((p) => ({ f: p.f, v: p.v, D: p.D })) : [];
      return { t: s.t, h: hand ? hand.h : null, tips, marked: !!neck };
    });
    const marked = st.hints.filter((x) => x.marked).length;
    const seen = st.hints.filter((x) => x.h != null).length;
    const shots = st.shots.length;
    ui.useLab.hidden = false;
    say(`Hand found on the neck in ${Math.round((seen / Math.max(1, st.hints.length)) * 100)}% of the frames` +
      (marked < st.hints.length ? `; ${Math.round(((st.hints.length - marked) / st.hints.length) * 100)}% are from camera angles without marks (mark the neck there too to use them)` : '') +
      `. ${shots > 1 ? `${shots} camera shots. ` : ''}The tab now keeps the hand where the video shows it.`);
    draw();
    onChange();
  }

  /**
   * For assignFrets: (time) => {h, w, tips}. h = hand position counted from the capo, w = how sure
   * (0-1), tips = the fingertips on the board in the nearest frame [{f, v, D}] (f counted from the capo,
   * v = mm across the board from its middle, sign depending on the camera; D = share of the scale).
   */
  function handHint(capoFret) {
    if (!st.hints || !ui.use.checked) return null;
    const hs = st.hints;
    return (time) => {
      let lo = 0;
      let hi = hs.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (hs[m].t < time - NEAR) lo = m + 1;
        else hi = m;
      }
      const near = [];
      let total = 0;
      let closest = null;
      for (let i = lo; i < hs.length && hs[i].t <= time + NEAR; i++) {
        if (!hs[i].marked) continue;
        total++;
        if (hs[i].h == null) continue;
        near.push(hs[i].h);
        if (!closest || Math.abs(hs[i].t - time) < Math.abs(closest.t - time)) closest = hs[i];
      }
      if (!near.length) return null;
      const tips = closest.tips.map((p) => ({ f: p.f - capoFret, v: p.v, D: p.D }));
      return { h: Math.max(1, median(near) - capoFret), w: near.length / total, tips };
    };
  }

  // ---------- drawing ----------

  function draw() {
    if (!st.src || !v.videoWidth) return;
    const r = v.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
    }
    const g = cv.getContext('2d');
    const k = (r.width / v.videoWidth) * dpr; // video pixels -> canvas pixels
    g.clearRect(0, 0, cv.width, cv.height);
    const t = st.marking ? v.currentTime : audio.currentTime;
    const neck = st.marking ? neckFromMarks(st.marks) : neckFor(t, st.marking ? null : nearestSample(t)?.thumb);

    if (neck) {
      const cap = +ui.capo.value || 0;
      for (let f = 0; f <= 19; f++) {
        const [x1, y1] = neck.point(f, -1);
        const [x2, y2] = neck.point(f, 1);
        g.strokeStyle = f === 0 ? 'rgba(255,255,255,.9)' : f === cap && cap ? 'rgba(242,169,59,.95)' : 'rgba(120,200,255,.55)';
        g.lineWidth = (f === 0 || (f === cap && cap) ? 3 : 1.2) * dpr;
        g.beginPath();
        g.moveTo(x1 * k, y1 * k);
        g.lineTo(x2 * k, y2 * k);
        g.stroke();
        if ([0, 3, 5, 7, 9, 12, 15].includes(f)) {
          g.fillStyle = 'rgba(120,200,255,.95)';
          g.font = `${11 * dpr}px system-ui`;
          g.fillText(String(f), x2 * k + 3 * dpr, y2 * k + 12 * dpr);
        }
      }
    }
    for (const m of st.marking ? st.marks : []) {
      for (const p of [m.a, m.b].filter(Boolean)) {
        g.fillStyle = '#f2a93b';
        g.beginPath();
        g.arc(p[0] * k, p[1] * k, 5 * dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (st.marking || !neck) return;

    // the fretting hand the model found now, and where the tab has it
    const s = nearestSample(t);
    const hand = s && Math.abs(s.t - t) <= STEP && fretHand(s.hands, neck);
    const lines = [];
    if (hand) {
      for (const tip of hand.tips) {
        g.fillStyle = tip.on ? 'rgba(80,220,120,.95)' : 'rgba(255,255,255,.35)';
        g.beginPath();
        g.arc(tip.x * k, tip.y * k, 4 * dpr, 0, Math.PI * 2);
        g.fill();
      }
      lines.push(`video: hand at fret ${hand.h}`);
    }
    const th = tabHandAt(t);
    if (th != null) {
      const [x1, y1] = neck.point(th - 0.5, -1.15);
      const [x2, y2] = neck.point(th - 0.5, 1.15);
      g.strokeStyle = 'rgba(242,169,59,.9)';
      g.setLineDash([6 * dpr, 4 * dpr]);
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.moveTo(x1 * k, y1 * k);
      g.lineTo(x2 * k, y2 * k);
      g.stroke();
      g.setLineDash([]);
      lines.push(`tab: hand at fret ${th}`);
    }
    if (lines.length) {
      g.font = `600 ${12 * dpr}px system-ui`;
      const tw = Math.max(...lines.map((l) => g.measureText(l).width));
      g.fillStyle = 'rgba(0,0,0,.6)';
      g.fillRect(6 * dpr, 6 * dpr, tw + 12 * dpr, (lines.length * 16 + 6) * dpr);
      lines.forEach((l, i) => {
        g.fillStyle = i === 0 && hand ? '#7be08f' : '#f2a93b';
        g.fillText(l, 12 * dpr, (21 + i * 16) * dpr);
      });
    }
  }

  function nearestSample(t) {
    const ss = st.samples;
    if (!ss.length) return null;
    let lo = 0;
    let hi = ss.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ss[m].t < t) lo = m + 1;
      else hi = m;
    }
    return lo > 0 && Math.abs(ss[lo - 1].t - t) < Math.abs(ss[lo].t - t) ? ss[lo - 1] : ss[lo];
  }

  return {
    load,
    unavailable,
    handHint,
    draw,
    setRange: (fn) => (tabRange = fn),
    // for checking from the dev console
    debug: { st, neckFromMarks, fretHand, follow, refreshHints,
      /** {samples, shots, necks: [{time, marks}]} as saved from st (thumbs as plain arrays): skips following again */
      restore: (saved) => {
        const f32 = (a) => Float32Array.from(a);
        st.samples = saved.samples.map((s) => ({ ...s, thumb: f32(s.thumb) }));
        st.shots = saved.shots.map((s) => ({ ...s, thumb: f32(s.thumb) }));
        st.necks = saved.necks.map((n) => ({ time: n.time, thumb: f32(n.thumb), neck: neckFromMarks(n.marks) }));
        showButtons();
        refreshHints();
      },
      save: () => JSON.stringify({
        samples: st.samples.map((s) => ({ ...s, thumb: [...s.thumb].map(Math.round) })),
        shots: st.shots.map((s) => ({ ...s, thumb: [...s.thumb].map(Math.round) })),
        necks: st.necks.map((n) => ({ time: n.time, thumb: [...n.thumb].map(Math.round), marks: n.neck.marks })),
      }),
      setMarks: (marks, time = v.currentTime) => {
      const neck = neckFromMarks(marks);
      if (neck) st.necks.push({ time, thumb: thumbOf(v), neck });
      showButtons();
      draw();
      return !!neck;
    } },
  };
}
