"""Test songs with a known time signature (Karplus-Strong plucks), to check meter detection.

python tools/make_meter_audio.py public/_bench
Writes six8_slow.wav, six8_fast.wav, waltz_quarters.wav, waltz_eighths.wav, four4.wav, waltz_short.wav,
four4_walk.wav and meters.json
({name: expected signature}).
"""
import json
import random
import struct
import sys
import wave
from pathlib import Path

RATE = 22050
random.seed(2)


def pluck(midi, seconds, amp):
    freq = 440 * 2 ** ((midi - 69) / 12)
    period = max(2, int(round(RATE / freq)))
    buf = [random.uniform(-1, 1) for _ in range(period)]
    out = []
    for i in range(int(seconds * RATE)):
        j = i % period
        out.append(buf[j] * amp)
        buf[j] = 0.996 * 0.5 * (buf[j] + buf[(j + 1) % period])
    return out


def render(path, notes, length, ring=1.6):
    """notes: (time, midi, amp); each rings `ring` seconds."""
    mix = [0.0] * int((length + 2) * RATE)
    for t, p, a in notes:
        t += random.uniform(-0.006, 0.006)
        off = int(t * RATE)
        for j, v in enumerate(pluck(p, ring, a)):
            if off + j < len(mix):
                mix[off + j] += v
    peak = max(abs(v) for v in mix)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(v / peak * 30000)) for v in mix))


# chords as (bass, three upper notes); 8 bars, changing every bar
PROG = [(40, 55, 59, 64), (45, 57, 60, 64), (50, 57, 62, 66), (43, 55, 59, 62)] * 2


def six8(eighth):
    """6/8 arpeggio: bass on 1, notes on every eighth, the top on 4 (like Nothing Else Matters)."""
    notes = []
    for b, (bass, x, y, z) in enumerate(PROG):
        t0 = b * 6 * eighth
        for k, p in enumerate([bass, x, y, z, y, x]):
            notes.append((t0 + k * eighth, p, 0.55 if k == 0 else 0.4 if k == 3 else 0.3))
    return notes, len(PROG) * 6 * eighth


def waltz(quarter, eighths):
    """3/4: bass on 1, chord on 2 and 3 (and eighths in between if asked)."""
    notes = []
    for b, (bass, x, y, z) in enumerate(PROG):
        t0 = b * 3 * quarter
        notes.append((t0, bass, 0.55))
        for k in (1, 2):
            for p in (x, y, z):
                notes.append((t0 + k * quarter, p, 0.3))
        if eighths:
            for k in range(3):
                notes.append((t0 + (k + 0.5) * quarter, z + 3, 0.25))
    return notes, len(PROG) * 3 * quarter


def four4(quarter):
    """4/4 Travis-like: bass on 1 and 3, upper notes on the eighths."""
    notes = []
    for b, (bass, x, y, z) in enumerate(PROG):
        t0 = b * 4 * quarter
        for k in range(8):
            t = t0 + k * quarter / 2
            if k in (0, 4):
                notes.append((t, bass if k == 0 else bass + 7, 0.55))
            else:
                notes.append((t, [x, y, z][k % 3], 0.3))
    return notes, len(PROG) * 4 * quarter


def walking(quarter):
    """4/4 with the bass on every beat (a walking bass) and a chord on 2 and 4."""
    notes = []
    for b, (bass, x, y, z) in enumerate(PROG):
        t0 = b * 4 * quarter
        for k in range(4):
            notes.append((t0 + k * quarter, bass + [0, 2, 4, 5][k], 0.5))
            if k % 2:
                for p in (x, y, z):
                    notes.append((t0 + k * quarter, p, 0.3))
    return notes, len(PROG) * 4 * quarter


out = Path(sys.argv[1])
songs = {
    "six8_slow": (six8(60 / 180), "6/8"),  # ♩. = 60
    "six8_fast": (six8(60 / 130), "6/8"),  # ♪ = 130 (♩. ≈ 43)
    "waltz_quarters": (waltz(60 / 120, False), "3/4"),
    "waltz_eighths": (waltz(60 / 100, True), "3/4"),
    "four4": (four4(60 / 90), "4/4"),
    # notes damped sooner, like a player lifting fingers between chords
    "waltz_short": (waltz(60 / 140, False), "3/4", 0.5),
    "four4_walk": (walking(60 / 110), "4/4", 0.5),
}
for name, ((notes, length), _, *ring) in songs.items():
    render(out / f"{name}.wav", notes, length, *ring)
(out / "meters.json").write_text(json.dumps({k: v[1] for k, v in songs.items()}))
print("wrote", ", ".join(songs))
