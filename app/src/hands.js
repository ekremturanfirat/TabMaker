// Angled 3D view of both hands, the way the player sees them looking down at the guitar.
// The hands are see-through, so the fingertips on the strings show; what is behind the neck
// (the left thumb and palm) is dashed. Left: the fretting hand holding its chord shape, fingers
// arched onto their strings (1 index … 4 pinky; a flat finger = barre). Right: p i m a by the
// sound hole; the finger that plucks follows through towards the palm.

const SCALE = 650; // nut to saddle, mm: the frets are spaced like on a real guitar
const GAP = 8.4; // string spacing, mm
const EDGE = 2.5 * GAP + 5; // half the neck's width
const NECK_T = 22; // neck thickness
const DEG = Math.PI / 180;
const H = 300;
const MAX_H = 270; // px: the drawing is never taller than this; a wider box widens the left hand's panel
const RIGHT_W = 360; // the right hand's panel, at the right end

const fretPos = (f) => SCALE * (1 - 2 ** (-f / 12));
const fretMid = (f) => (f <= 0 ? -9 : (fretPos(f - 1) + fretPos(f)) / 2);
const pressX = (f) => fretPos(f) - Math.min(9, 0.28 * (fretPos(f) - fretPos(f - 1))); // just behind the fret wire
const strY = (s) => (s - 2.5) * GAP; // low E nearest the eye, high e far (on top, like the tab)

const FINGER = [null, [40, 25, 19], [44, 28, 20], [42, 26, 19], [33, 20, 17]]; // index … pinky: bones, mm
const RFINGER = { i: [38, 23, 18], m: [42, 26, 19], a: [40, 24, 18], c: [31, 19, 16] };
const COLOR = [null, '#4ea1ff', '#4fc94f', '#f2a93b', '#c06cf0']; // fingers 1-4, as on the flat fretboard
// finger widths at the knuckle, the two joints and the tip, mm
const FINGER_W = [null, [15, 14, 13, 11.5], [15.5, 14.5, 13.3, 11.8], [14.5, 13.5, 12.5, 11.2], [12.5, 11.6, 10.8, 9.8]];
const RFINGER_W = { i: [15, 14, 13, 11.5], m: [15.5, 14.5, 13.5, 12], a: [14.5, 13.5, 12.5, 11.2], c: [12.5, 11.6, 10.8, 9.8] };
const THUMB_W = [20, 17.5, 15];
const THUMB_L = [30, 24];
const THUMB_R = [32, 28];
const ARCH = [[0.42, 0.8], [1, 0.62]]; // where the two finger joints sit along the finger, and how high
// right hand at rest: each finger prepared on its string (classical: p on the bass, i m a on G B e)
const R_KNUCKLE = { i: [-16, -15, 42], m: [-4, -13, 44], a: [8, -13, 42], c: [18, -15, 38] };
const R_REST = { i: [-18, strY(3), 2.2], m: [-6, strY(4), 2.2], a: [6, strY(5), 2.2], c: [17, strY(5) + 7, 13] };
const R_FOLLOW = { p: [2, 8, 3], i: [1, -10, 8], m: [1, -10, 8], a: [1, -10, 8] }; // follow-through, mm
const PLUCK_IN = 0.09; // s to go through the string
const PLUCK_OUT = 0.28; // s to come back

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, k) => a.map((v) => v * k);
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const len = (a) => Math.hypot(...a);

/**
 * Perspective camera; world x runs along the neck (towards the bridge), y across it (low E → high e),
 * z up off the strings. It turns `yaw` around the strings' plane, then looks down at `tilt`.
 */
function camera({ cx, cy, F, D, at = [0, 0, 0], yaw = 0, tilt }) {
  const sa = Math.sin(tilt);
  const ca = Math.cos(tilt);
  const sy = Math.sin(yaw);
  const cyw = Math.cos(yaw);
  const view = (p) => {
    const x = p[0] - at[0];
    const y = p[1] - at[1];
    const z = p[2] - at[2];
    const across = x * cyw - y * sy;
    const away = x * sy + y * cyw;
    return [across, away * sa + z * ca, away * ca - z * sa];
  };
  const k = (p) => F / (D + view(p)[2]);
  const P = (p) => {
    const [x, up, depth] = view(p);
    const s = F / (D + depth);
    return [cx + x * s, cy - up * s];
  };
  P.k = k;
  P.z = (p) => view(p)[2]; // distance from the eye: smaller is nearer
  return P;
}

const xy = (q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`;
const poly = (P, pts, cls) => `<polygon class="${cls}" points="${pts.map((p) => xy(P(p))).join(' ')}"/>`;
const line = (P, a, b, cls, w) => {
  const [p, q] = [P(a), P(b)];
  return `<line class="${cls}" x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}"${w ? ` style="stroke-width:${w.toFixed(2)}"` : ''}/>`;
};
/** A flat circle lying on the strings' plane (inlays, sound hole), as the polygon the eye sees. */
const disc = (P, c, r, cls, n = 28) =>
  poly(P, Array.from({ length: n }, (_, i) => add(c, [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI), 0])), cls);

/** Finger joints from knuckle K to fingertip T: arched up (more the closer the tip is), or flat for a barre. */
function joints(K, T, bones, flat = 0, arch = ARCH) {
  const L = bones.reduce((a, b) => a + b, 0);
  const c = sub(T, K);
  const d = len(c) || 1;
  const dir = mul(c, 1 / d);
  let up = sub([0, 0, 1], mul(dir, dir[2])); // up, square to the finger
  up = len(up) > 0.1 ? mul(up, 1 / len(up)) : [0, 1, 0];
  const h = Math.sqrt(Math.max(0, L * L - d * d)) * 0.42 * (1 - flat) + flat * 2;
  const out = [K, ...arch[0].map((t, i) => add(lerp(K, T, t), mul(up, h * arch[1][i]))), T];
  out.up = up;
  return out;
}

const LIGHT = [-0.55, -0.83]; // screen direction the light comes from (upper left)
const pathOf = (pts) => `M${pts.map(xy).join('L')}Z`;
const unit = (a) => mul(a, 1 / (len(a) || 1));
const dot = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0);

/** Smooth curve (Catmull-Rom) through the joints, with the width at each sample; a little wider at the knuckles. */
function smooth(pts, widths, per = 6) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? sub(mul(pts[0], 2), pts[1]) : pts[i - 1];
    const p3 = i + 2 >= n ? sub(mul(pts[n - 1], 2), pts[n - 2]) : pts[i + 2];
    const [p1, p2] = [pts[i], pts[i + 1]];
    for (let j = 0; j < per; j++) {
      const t = j / per;
      const p = p1.map((_, c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * t * t * t));
      const bump = 1 + 0.09 * ((i > 0 ? Math.exp(-(t * t) / 0.012) : 0) + (i < n - 2 ? Math.exp(-((1 - t) ** 2) / 0.012) : 0));
      out.push({ p, w: (widths[i] + (widths[i + 1] - widths[i]) * t) * bump });
    }
  }
  out.push({ p: pts[n - 1], w: widths[n - 1] });
  return out;
}

/**
 * Screen outline of a tube with radii r (scaled by `k`), its centre moved `lift` of a radius towards the
 * light; the far end is rounded (and the near end too with cap0).
 */
function outline(q, r, n, k = 1, lift = 0, cap0 = false) {
  const c = q.map((p, i) => {
    const off = dot(n[i], LIGHT) * lift * r[i];
    return [p[0] + n[i][0] * off, p[1] + n[i][1] * off];
  });
  const side = (sg) => c.map((p, i) => [p[0] + sg * n[i][0] * r[i] * k, p[1] + sg * n[i][1] * r[i] * k]);
  const cap = (i, fwd) => Array.from({ length: 7 }, (_, j) => {
    const a = ((j + 1) / 8) * Math.PI;
    const f = [n[i][1] * fwd, -n[i][0] * fwd];
    return [c[i][0] + (n[i][0] * Math.cos(a) + f[0] * Math.sin(a)) * r[i] * k, c[i][1] + (n[i][1] * Math.cos(a) + f[1] * Math.sin(a)) * r[i] * k];
  });
  const e = c.length - 1;
  return pathOf([...side(1), ...cap(e, 1), ...side(-1).reverse(), ...(cap0 ? cap(0, -1).reverse() : [])]);
}

/**
 * A finger, thumb or arm as a shaded, tapering tube through its joints: a dark rim, the skin a little
 * towards the light, a soft highlight, creases over the joints and a nail at the tip when they face you.
 * widths: mm at each joint. Returns the SVG and the 3D centre line (for its shadow).
 */
function tube(P, pts, widths, { nail = true, creases = true, cap0 = false } = {}) {
  const per = 6;
  const S = smooth(pts, widths, per);
  const q = S.map((s) => P(s.p));
  const r = S.map((s) => (s.w * P.k(s.p)) / 2);
  const n = q.map((_, i) => {
    const a = q[Math.max(0, i - 1)];
    const b = q[Math.min(q.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  });
  let out = `<path class="hv-rim" d="${outline(q, r, n, 1, 0, cap0)}"/>` +
    `<path class="hv-skin" d="${outline(q, r, n, 0.82, 0.18, cap0)}"/>` +
    `<path class="hv-lit" d="${outline(q, r, n, 0.3, 0.55, cap0)}"/>`;
  // the back of the finger: away from the inside of its curl
  const K = pts[0];
  const T = pts[pts.length - 1];
  const chord = unit(sub(T, K));
  const back = (p) => {
    const o = sub(p, add(K, mul(chord, dot(sub(p, K), chord))));
    return len(o) > 0.5 ? unit(o) : pts.up || [0, 0, 1];
  };
  const facing = (p, v) => P.z(add(p, v)) < P.z(p);
  if (creases) {
    for (let j = 1; j < pts.length - 1; j++) {
      const i = j * per;
      if (!facing(pts[j], back(pts[j]))) continue;
      const f = [n[i][1], -n[i][0]];
      const [a, b] = [-1, 1].map((sg) => [q[i][0] + sg * n[i][0] * r[i] * 0.55, q[i][1] + sg * n[i][1] * r[i] * 0.55]);
      out += `<path class="hv-crease" d="M${xy(a)}Q${xy([q[i][0] + f[0] * r[i] * 0.35, q[i][1] + f[1] * r[i] * 0.35])} ${xy(b)}"/>`;
    }
  }
  if (nail) {
    const D = pts[pts.length - 2];
    const dir = unit(sub(T, D));
    let bk = back(D);
    bk = sub(bk, mul(dir, dot(bk, dir)));
    bk = len(bk) > 0.2 ? unit(bk) : pts.up || [0, 0, 1];
    const wt = widths[widths.length - 1];
    const c3 = add(lerp(D, T, 0.7), mul(bk, wt * 0.4));
    if (facing(c3, bk)) {
      const c = P(c3);
      const ax = sub(P(add(c3, dir)), c);
      const ang = (Math.atan2(ax[1], ax[0]) * 180) / Math.PI;
      const kk = P.k(c3);
      const rx = Math.max(1.2, len(sub(T, D)) * 0.24 * kk * Math.min(1, len(ax) / kk + 0.25));
      const ry = wt * 0.34 * kk;
      out += `<g transform="translate(${xy(c)}) rotate(${ang.toFixed(1)})"><ellipse class="hv-nail" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"/>` +
        `<ellipse class="hv-nail-tip" cx="${(rx * 0.55).toFixed(1)}" rx="${(rx * 0.4).toFixed(1)}" ry="${(ry * 0.8).toFixed(1)}"/></g>`;
    }
  }
  return { svg: out, line: S };
}

/** The soft shadow a tube casts on the surface at height z0, the light coming from `sv` (mm per mm of height). */
function shadow(P, S, z0, sv, scale = 1) {
  const pts = S.map((s) => {
    const h = Math.max(0, s.p[2] - z0);
    return P([s.p[0] + sv[0] * h, s.p[1] + sv[1] * h, z0]);
  });
  const w = S.reduce((t, s) => t + s.w, 0) / S.length;
  return `<path d="M${pts.map(xy).join('L')}" style="stroke-width:${(w * scale * P.k(S[S.length - 1].p)).toFixed(1)}"/>`;
}

/** A rounded closed shape through 3D points (back of the hand). */
function blob(P, pts, cls, round = 0.35) {
  const q = pts.map(P);
  let d = '';
  q.forEach((p, i) => {
    const a = q[(i - 1 + q.length) % q.length];
    const b = q[(i + 1) % q.length];
    const s = lerp(p, a, round / 2 + 0.0001);
    const e = lerp(p, b, round / 2 + 0.0001);
    d += `${i ? 'L' : 'M'}${xy(s)}Q${xy(p)} ${xy(e)}`;
  });
  return `<path class="${cls}" d="${d}Z"/>`;
}

/** Outline polygon of a thick polyline, in screen space (for the parts drawn dashed behind the neck). */
function ribbon(P, pts, w) {
  const q = pts.map(P);
  const left = [];
  const right = [];
  q.forEach((p, i) => {
    const a = q[Math.max(0, i - 1)];
    const b = q[Math.min(q.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const n = Math.hypot(dx, dy) || 1;
    const r = (w * P.k(pts[i])) / 2;
    left.push([p[0] - (dy / n) * r, p[1] + (dx / n) * r]);
    right.push([p[0] + (dy / n) * r, p[1] - (dx / n) * r]);
  });
  return [...left, ...right.reverse()].map(xy).join(' ');
}

/** Number of seconds' follow-through of a pluck at `t` s after it: 0 → 1 (through the string) → 0. */
const follow = (t) => (t < 0 ? 0 : t < PLUCK_IN ? t / PLUCK_IN : Math.max(0, 1 - (t - PLUCK_IN) / PLUCK_OUT));

const DEFS =
  '<linearGradient id="hv-g-board" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#24150e"/><stop offset=".45" stop-color="#3b2418"/><stop offset="1" stop-color="#2a1810"/></linearGradient>' +
  '<linearGradient id="hv-g-side" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6b4429"/><stop offset="1" stop-color="#2a190f"/></linearGradient>' +
  '<linearGradient id="hv-g-top" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9a065"/><stop offset="1" stop-color="#9c733f"/></linearGradient>' +
  '<radialGradient id="hv-g-pearl" cx=".4" cy=".35"><stop offset="0" stop-color="#fffaf0"/><stop offset=".55" stop-color="#ddd5c6"/><stop offset="1" stop-color="#9a9284"/></radialGradient>' +
  '<radialGradient id="hv-g-hole" cx=".5" cy=".42"><stop offset=".6" stop-color="#050403"/><stop offset="1" stop-color="#1c130b"/></radialGradient>' +
  '<filter id="hv-f-shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.4"/></filter>' +
  '<filter id="hv-f-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.9"/></filter>';

export function createHandView(root) {
  root.innerHTML =
    `<svg role="img" aria-label="Both hands seen from the player's eyes: left-hand fingers on the neck, right-hand p i m a by the sound hole">` +
    `<defs>${DEFS}<clipPath id="hv-cl"><rect class="hv-cl" height="${H}"/></clipPath><clipPath id="hv-cr"><rect class="hv-cr" width="${RIGHT_W}" height="${H}"/></clipPath></defs>` +
    `<g class="hv-l" clip-path="url(#hv-cl)"></g><g class="hv-r" clip-path="url(#hv-cr)"></g>` +
    `<line class="hv-split" y1="0" y2="${H}"/>` +
    `<text class="hv-title" x="14" y="20">LEFT HAND · as you see it looking down</text>` +
    `<text class="hv-title hv-title-r" y="20">RIGHT HAND · from the front</text></svg><div class="hv-cap"></div>`;
  const svg = root.querySelector('svg');
  const gL = root.querySelector('.hv-l');
  const gR = root.querySelector('.hv-r');
  const cap = root.querySelector('.hv-cap');

  // the drawing is as wide as its box allows at MAX_H high (1000 at least): the left panel takes the rest
  let W = 1000;
  let SPLIT = W - RIGHT_W;
  function layout() {
    W = Math.max(1000, Math.round((H * (root.clientWidth || 1000)) / MAX_H));
    SPLIT = W - RIGHT_W;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    root.querySelector('.hv-cl').setAttribute('width', SPLIT);
    root.querySelector('.hv-cr').setAttribute('x', SPLIT);
    for (const a of ['x1', 'x2']) root.querySelector('.hv-split').setAttribute(a, SPLIT);
    root.querySelector('.hv-title-r').setAttribute('x', SPLIT + 14);
  }
  layout();
  new ResizeObserver(() => {
    const w = W;
    layout();
    if (W !== w && goal) render();
  }).observe(root);

  // what is drawn (v) eases towards where it should be (t), so the hands glide
  const cur = { camX: 0, handX: 0, tips: [], flat: [], thumbR: 0 };
  let goal = null;
  let info = { held: [-1, -1, -1, -1, -1, -1], fingers: [-1, -1, -1, -1, -1, -1], sounding: [], plucks: [], next: null };
  let labels = ['E', 'A', 'D', 'G', 'B', 'e'];
  let lastKey = null;
  let hand = 1;
  let capo = 0; // frets count from the capo, as in the tab
  let thumbS = 1;
  const pluckAt = {};
  let raf = 0;
  let last = 0;

  function targets() {
    const handX = (fretMid(hand + capo) + fretMid(hand + capo + 3)) / 2 - 3;
    const g = { camX: Math.max(105, handX + 12), handX, tips: [null], flat: [null], thumbR: thumbS };
    for (let k = 1; k <= 4; k++) {
      const strings = info.fingers.map((f, s) => (f === k && info.held[s] > 0 ? s : -1)).filter((s) => s >= 0);
      const nx = info.next?.fingers?.findIndex((f, s) => f === k && info.next.frets[s] > 0) ?? -1;
      if (strings.length) {
        const s = Math.min(...strings);
        g.tips[k] = [pressX(info.held[s] + capo), strY(s) - (strings.length > 1 ? 1.5 : 0), 2];
        g.flat[k] = strings.length > 1 ? 1 : 0;
      } else if (nx >= 0) {
        g.tips[k] = [pressX(info.next.frets[nx] + capo) - 1, strY(nx) + 1.5, 9]; // ready above the next note
        g.flat[k] = 0;
      } else {
        g.tips[k] = [fretMid(hand + capo + k - 1), strY(4.3), 12]; // free: hovering close above the strings
        g.flat[k] = 0;
      }
    }
    return g;
  }

  /** Move every eased value a step towards its goal; true while something still moves. */
  function ease(a) {
    let d = 0;
    const step = (v, t) => {
      d = Math.max(d, Math.abs(t - v));
      return v + (t - v) * a;
    };
    // a value that ever went wrong would stay wrong for good: start it again from where it should be
    const bad = (v) => !Number.isFinite(v);
    if ([cur.camX, cur.handX, cur.thumbR, ...cur.tips.slice(1).flat(), ...cur.flat.slice(1)].some(bad)) Object.assign(cur, structuredClone(goal));
    cur.camX = step(cur.camX, goal.camX);
    cur.handX = step(cur.handX, goal.handX);
    cur.thumbR = step(cur.thumbR, goal.thumbR);
    for (let k = 1; k <= 4; k++) {
      cur.tips[k] = cur.tips[k].map((v, i) => step(v, goal.tips[k][i]));
      cur.flat[k] = step(cur.flat[k], goal.flat[k]);
    }
    return d > 0.05;
  }

  function frame() {
    // the clock, not the frame's own time: that one can lag behind kick() (by minutes in a page left in
    // the background while a long song is worked out), and a step back in time throws the hands off to infinity
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const moving = ease(1 - Math.exp(-dt / 0.07));
    render(now);
    const plucking = Object.values(pluckAt).some((t) => now - t < (PLUCK_IN + PLUCK_OUT) * 1000);
    raf = moving || plucking ? requestAnimationFrame(frame) : 0;
  }
  function kick() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  /** A string: bronze-wound (E A D G, the steel-string guitar's) or plain steel; a sounding one glows and blurs as it shakes. */
  function string(P, a, b, s, on) {
    const w = (0.45 + (5 - s) * 0.13) * P.k([0, strY(s), 0]);
    let o = line(P, a, b, `hv-str${s <= 3 ? ' wound' : ''}${on ? ' on' : ''}`, w);
    if (s <= 3) o += line(P, a, b, 'hv-wind', w);
    o += line(P, a, b, 'hv-str-hi', w * 0.35);
    if (on) {
      const [p, q] = [P(a), P(b)];
      for (const d of [-1, 1]) {
        const dy = d * (w * 0.9 + 0.7);
        o += `<line class="hv-vib" x1="${p[0].toFixed(1)}" y1="${(p[1] + dy).toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${(q[1] + dy).toFixed(1)}" style="stroke-width:${w.toFixed(2)}"/>`;
      }
    }
    return o;
  }

  /** Wood grain: thin wavy lines along x on the plane z, between y0 and y1. */
  function grain(P, x0, x1, y0, y1, z, count, cls) {
    let o = '';
    for (let i = 0; i < count; i++) {
      const pts = [];
      for (let x = x0; x <= x1 + 1; x += Math.max(20, (x1 - x0) / 14)) {
        pts.push(P([x, y0 + ((i + 0.5) / count) * (y1 - y0) + 0.8 * Math.sin(x * 0.013 + i * 2.1), z]));
      }
      o += `<path class="${cls}" d="M${pts.map(xy).join('L')}" style="opacity:${(0.12 + ((i * 37) % 10) / 40).toFixed(2)}"/>`;
    }
    return o;
  }

  function renderLeft() {
    // as you see it looking down at your own hand: high e far (on top, like the tab), fingers coming over it
    const P = camera({ cx: SPLIT / 2, cy: 190, F: 740, D: 260, at: [cur.camX, 0, 0], tilt: 62 * DEG });
    const SV = [0.22, -0.3]; // the light comes from the nut side and from beyond the high e
    const xa = Math.max(-60, cur.camX - 420);
    const xb = cur.camX + 420;
    const x0 = Math.max(0, xa);
    const sounding = (s) => info.sounding[s];
    let out = '';

    // the hand under the neck: palm and thumb, drawn first so the neck covers them
    const K = [null, 1, 2, 3, 4].map((k) => k && [cur.handX + (k - 2.5) * 19, EDGE + 13, 9]);
    const palm = [add(K[1], [-9, 0, -3]), add(K[4], [9, 1, -4]), add(K[4], [13, 8, -40]), add(K[1], [-16, 4, -42])];
    const thumb = joints(add(K[1], [-6, -9, -30]), [K[1][0] + 15, -1, -NECK_T - 3], THUMB_L, 0, [[0.5], [0.4]]);
    const thumbPts = ribbon(P, thumb, 17);
    out += `<g class="hv-hidden">${poly(P, palm, 'hv-palm')}<polygon class="hv-palm" points="${thumbPts}"/></g>`;

    // the neck: its side towards you with the binding, the rosewood fretboard, pearl dots, frets, nut
    out += poly(P, [[xa, -EDGE, 0], [xb, -EDGE, 0], [xb, -EDGE, -NECK_T], [xa, -EDGE, -NECK_T]], 'hv-neck-side');
    if (xa < 0) out += poly(P, [[xa, -EDGE - 4, 0], [0, -EDGE, 0], [0, EDGE, 0], [xa, EDGE + 4, 0]], 'hv-head');
    out += poly(P, [[x0, -EDGE, 0], [xb, -EDGE, 0], [xb, EDGE, 0], [x0, EDGE, 0]], 'hv-board');
    out += grain(P, x0, xb, -EDGE + 1, EDGE - 1, 0, 16, 'hv-grain');
    out += line(P, [x0, -EDGE, -0.3], [xb, -EDGE, -0.3], 'hv-binding', 1.1 * P.k([0, -EDGE, 0]));
    for (let f = 1; f <= 24; f++) {
      const x = fretMid(f);
      if (x < xa || x > xb) continue;
      if (f % 12 === 0) out += disc(P, [x, strY(1.5), 0], 3.2, 'hv-inlay') + disc(P, [x, strY(3.5), 0], 3.2, 'hv-inlay');
      else if ([3, 5, 7, 9].includes(f % 12)) out += disc(P, [x, 0, 0], 3.4, 'hv-inlay');
      if ([1, 3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f) || f === hand + capo) {
        const q = P([x, -EDGE, -NECK_T / 2 - 4]);
        out += `<text class="hv-num${f === hand + capo ? ' on' : ''}" x="${q[0].toFixed(1)}" y="${q[1].toFixed(1)}">${f}</text>`;
      }
    }
    for (let f = 1; f <= 24; f++) {
      const x = fretPos(f);
      if (x < xa || x > xb) continue;
      const w = P.k([x, 0, 0]) * 0.55;
      out += line(P, [x, -EDGE, 0.8], [x, EDGE, 0.8], 'hv-fret', 2 * w) + line(P, [x - 0.3, -EDGE, 1.1], [x - 0.3, EDGE, 1.1], 'hv-fret-hi', 0.6 * w) +
        line(P, [x, -EDGE, 0.8], [x, -EDGE, -2.5], 'hv-fret-side', 1.4 * w);
    }
    if (xa < 0) out += line(P, [0, -EDGE - 1, 1.6], [0, EDGE + 1, 1.6], 'hv-nut', 3.4 * P.k([0, 0, 0])) + line(P, [-0.8, -EDGE - 1, 2.2], [-0.8, EDGE + 1, 2.2], 'hv-nut-hi', 0.9 * P.k([0, 0, 0]));
    const capoX = fretPos(capo) - 5; // the capo clamps the strings just behind its fret
    if (capo && capoX > xa) {
      out += line(P, [capoX, -EDGE - 3, 3.5], [capoX, EDGE + 3, 3.5], 'hv-capo', 7 * P.k([capoX, 0, 0])) +
        line(P, [capoX - 1.5, -EDGE - 3, 5], [capoX - 1.5, EDGE + 3, 5], 'hv-capo-hi', 1.4 * P.k([capoX, 0, 0]));
    }

    // the fingers (drawn further down), so their shadows can go under the strings first
    const fingers = [];
    for (let k = 4; k >= 1; k--) {
      const pts = joints(K[k], cur.tips[k], FINGER[k], cur.flat[k]);
      fingers.push({ k, pts, t: tube(P, pts, FINGER_W[k], { cap0: true }) });
    }
    const backPts = [add(K[1], [-11, 2, -1]), add(K[4], [10, 2, -2]), add(K[4], [13, 9, -30]), add(K[1], [-15, 6, -32])];
    let sh = '';
    for (let s = 0; s < 6; s++) sh += line(P, [x0, strY(s) + SV[1] * 1.6, 0], [xb, strY(s) + SV[1] * 1.6, 0], 'hv-sh-str', 0.5 * P.k([0, 0, 0]));
    for (const f of fingers) sh += shadow(P, f.t.line, 0, SV, 0.9);
    for (const f of fingers) if (f.pts[3][2] < 4) sh += disc(P, [f.pts[3][0] + 1, f.pts[3][1] - 1.5, 0], 4.5, 'hv-contact', 14);
    out += `<g class="hv-shadow">${sh}</g>`;

    for (let s = 0; s < 6; s++) {
      out += string(P, [Math.max(-58, xa), strY(s), 1.6], [xb, strY(s), 1.6], s, sounding(s));
      const q = P([0, strY(s), 1.6]);
      out += `<text class="hv-lbl" x="12" y="${(q[1] + 4).toFixed(1)}">${labels[s]}</text>`;
      if (info.held[s] === 0 && sounding(s) && (capo ? capoX - 6 : -7) > xa) out += disc(P, [capo ? capoX - 6 : -7, strY(s), 1.6], 3.4, 'hv-open');
    }
    // the next notes: dashed rings where the fingers go next
    info.next?.frets.forEach((f, s) => {
      if (f > 0) out += disc(P, [pressX(f + capo), strY(s), 1.6], 3.6, 'hv-next', 20);
    });

    // what the neck hides, seen through it
    out += `<g class="hv-dash">${poly(P, palm, '')}<polygon points="${thumbPts}"/></g>`;
    // the back of the hand along the knuckles, then the fingers, pinky first
    let hand3 = blob(P, backPts, 'hv-back');
    for (let k = 1; k <= 4; k++) {
      const q = P(add(K[k], [0, 1, 4]));
      const kk = P.k(K[k]);
      hand3 += `<ellipse class="hv-knuckle" cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" rx="${(5.5 * kk).toFixed(1)}" ry="${(3.2 * kk).toFixed(1)}"/>`;
    }
    let tipsOut = '';
    for (const { k, t } of fingers) {
      hand3 += t.svg;
      const pressing = info.fingers.some((f, s) => f === k && info.held[s] > 0);
      const now = info.fingers.some((f, s) => f === k && info.held[s] > 0 && sounding(s));
      tipsOut += badge(P(cur.tips[k]), k, `hv-tip${pressing ? ' on' : ''}${now ? ' now' : ''}`, COLOR[k]);
    }
    out += `<g class="hv-hand">${hand3}</g>`;
    gL.classList.toggle('idle', !info.active);
    gL.innerHTML = out + tipsOut;
  }

  function renderRight(now) {
    // from the front, like a listener a little below the guitar: strings across, the neck to the right,
    // the hand hanging from above with the thumb ahead of the fingers, and the fingers' curl shows
    const P = camera({ cx: SPLIT + (W - SPLIT) / 2 + 10, cy: 200, F: 640, D: 260, at: [-14, 0, 12], yaw: 180 * DEG, tilt: 62 * DEG });
    const SV = [-0.25, 0.32]; // the light comes from the bridge side and from above the bass strings
    const TOP = -9; // the guitar's top, under the strings
    let out = '';
    out += poly(P, [[-420, -140, TOP], [300, -140, TOP], [300, 140, TOP], [-420, 140, TOP]], 'hv-top');
    out += grain(P, -420, 300, -140, 140, TOP, 34, 'hv-spruce');
    for (const [r, cls] of [[54, 'hv-ros-a'], [51, 'hv-ros-b'], [47.5, 'hv-ros-a']]) out += disc(P, [-64, 0, TOP], r, cls, 44);
    out += disc(P, [-64, 0, TOP], 43, 'hv-hole', 44);
    out += poly(P, [[-400, -EDGE, TOP], [-112, -EDGE, TOP], [-112, -EDGE, 0], [-400, -EDGE, 0]], 'hv-neck-side');
    out += poly(P, [[-400, -EDGE, 0], [-112, -EDGE, 0], [-112, EDGE, 0], [-400, EDGE, 0]], 'hv-board');
    out += poly(P, [[-112, -EDGE, 0], [-112, EDGE, 0], [-112, EDGE, TOP], [-112, -EDGE, TOP]], 'hv-board-end');

    const off = (f) => mul(R_FOLLOW[f], follow((now - (pluckAt[f] ?? -1e9)) / 1000));
    const plucking = new Set(info.plucks.map((p) => p.f));
    const thumbTip = add([-42, strY(cur.thumbR), 2], off('p'));
    const thumb = tube(P, joints([-18, -38, 48], thumbTip, THUMB_R, 0, [[0.52], [0.35]]), THUMB_W);
    const tips = {};
    const fingers = ['i', 'm', 'a', 'c'].map((f) => { // farthest from the eye first
      tips[f] = f === 'c' ? R_REST.c : add(R_REST[f], off(f));
      return tube(P, joints(R_KNUCKLE[f], tips[f], RFINGER[f]), RFINGER_W[f]);
    });
    const arm = tube(P, [[16, -60, 66], [110, -140, 104]], [52, 64], { nail: false, creases: false });
    const backPts = [[-26, -42, 52], [-23, -16, 41], [-4, -12, 46], [24, -15, 38], [36, -58, 62], [-4, -64, 66]];

    let sh = '';
    for (let s = 0; s < 6; s++) sh += line(P, [-300, strY(s) + SV[1] * 10.6, TOP], [260, strY(s) + SV[1] * 10.6, TOP], 'hv-sh-str', 0.6 * P.k([0, 0, 0]));
    for (const t of [thumb, ...fingers, arm]) sh += shadow(P, t.line, TOP, SV);
    sh += `<polygon class="hv-sh-fill" points="${backPts.map((p) => xy(P([p[0] + SV[0] * (p[2] - TOP), p[1] + SV[1] * (p[2] - TOP), TOP]))).join(' ')}"/>`;
    out += `<g class="hv-shadow">${sh}</g>`;
    for (let s = 0; s < 6; s++) out += string(P, [-300, strY(s), 1.6], [260, strY(s), 1.6], s, info.sounding[s]);

    // thumb ahead of the fingers towards the neck, the fingers, then the forearm and back of the hand over them
    let hand3 = thumb.svg + fingers.map((t) => t.svg).join('') + arm.svg + blob(P, backPts, 'hv-back', 0.5);
    const wrist = lerp(backPts[4], backPts[5], 0.5);
    for (const f of ['i', 'm', 'a', 'c']) {
      const k3 = add(R_KNUCKLE[f], [0, -3, 4]);
      const q = P(k3);
      const kk = P.k(k3);
      hand3 += `<path class="hv-tendon" d="M${xy(P(lerp(wrist, k3, 0.25)))}L${xy(P(lerp(wrist, k3, 0.9)))}"/>` +
        `<ellipse class="hv-knuckle" cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" rx="${(4.8 * kk).toFixed(1)}" ry="${(3 * kk).toFixed(1)}"/>`;
    }
    out += `<g class="hv-hand">${hand3}</g>`;
    let tipsOut = '';
    for (const f of ['i', 'm', 'a']) tipsOut += badge(P(tips[f]), f, `hv-pima ${f}${plucking.has(f) ? ' on' : ''}`);
    tipsOut += badge(P(thumbTip), 'p', `hv-pima p${plucking.has('p') ? ' on' : ''}`);
    gR.innerHTML = out + tipsOut;
  }

  /** A small labelled marker on a fingertip: 1-4 on the left hand, p i m a on the right. */
  function badge(q, label, cls, color) {
    return `<circle class="${cls}" cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="6.8"${color ? ` style="--c:${color}"` : ''}/>` +
      `<text class="hv-badge-t" x="${q[0].toFixed(1)}" y="${(q[1] + 3.4).toFixed(1)}">${label}</text>`;
  }

  function render(now = performance.now()) {
    renderLeft();
    renderRight(now);
  }

  return {
    setTuning(l) {
      labels = l;
    },
    /**
     * Show a moment of the music.
     * active: something is being played · hand: index-finger fret · held/fingers: the chord shape the
     * left hand holds (fret / finger per string) · sounding: strings that sound now · plucks: [{s, f: 'p'|'i'|'m'|'a'}]
     * · next: {frets, fingers} coming up · capo: its fret (frets count from it) · key: changes on every new pluck · caption: tip for this passage (HTML)
     */
    show(next) {
      info = { ...info, ...next };
      if (info.hand != null) hand = info.hand;
      capo = info.capo || 0;
      const bass = info.plucks.filter((p) => p.f === 'p').map((p) => p.s);
      const nextBass = info.next?.frets.findIndex((f, s) => s < 3 && f >= 0) ?? -1;
      if (bass.length) thumbS = Math.min(...bass);
      else if (nextBass >= 0) thumbS = nextBass;
      if (info.key !== lastKey) {
        const t = performance.now();
        for (const p of info.plucks) pluckAt[p.f] = t;
        lastKey = info.key;
      }
      const first = !goal;
      goal = targets();
      if (first) Object.assign(cur, structuredClone(goal));
      if (cap.innerHTML !== (info.caption || '')) cap.innerHTML = info.caption || '';
      if (first) render();
      kick();
    },
  };
}
