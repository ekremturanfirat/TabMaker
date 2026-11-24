"""Make a plucked-guitar test file with known notes (Karplus-Strong synthesis).

python tools/make_test_audio.py public/test.wav
Prints the expected notes so the generated tab can be checked.
"""
import random
import struct
import sys
import wave

RATE = 22050
BPM = 100
EIGHTH = 60 / BPM / 2


def pluck(midi, seconds, amp=0.5):
    freq = 440 * 2 ** ((midi - 69) / 12)
    period = int(RATE / freq)
    buf = [random.uniform(-1, 1) for _ in range(period)]
    out = []
    for i in range(int(seconds * RATE)):
        j = i % period
        nxt = buf[(j + 1) % period]
        out.append(buf[j] * amp)
        buf[j] = 0.996 * 0.5 * (buf[j] + nxt)
    return out


# (start in eighths, list of midi notes) — a C major scale, then G, C, D, Em chords
SCORE = [(i, [p]) for i, p in enumerate([48, 50, 52, 53, 55, 57, 59, 60])]
SCORE += [(10, [43, 47, 50, 55, 59, 67]), (14, [48, 52, 55, 60, 64]), (18, [50, 57, 62, 66]), (22, [40, 47, 52, 55, 59, 64])]

total = int((SCORE[-1][0] * EIGHTH + 3) * RATE)
mix = [0.0] * total
for start, notes in SCORE:
    for k, p in enumerate(notes):
        offset = int((start * EIGHTH + k * 0.01) * RATE)
        for i, v in enumerate(pluck(p, 2.5, 0.35)):
            if offset + i < total:
                mix[offset + i] += v

peak = max(abs(v) for v in mix)
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", int(v / peak * 30000)) for v in mix))

print("expected:", SCORE)
