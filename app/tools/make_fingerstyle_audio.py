"""Fingerstyle test audio with known notes: Travis picking (thumb on every beat, alternating bass),
arpeggios that ring, and repeated notes. Karplus-Strong plucks; each note rings until its string is
plucked again. Writes WAV + JSON of the true notes [{pitch, time}].
python tools/make_fingerstyle_audio.py public/_bench/finger.wav public/_bench/finger.json
"""
import json
import random
import struct
import sys
import wave

random.seed(1)
RATE = 22050
BPM = 96
BEAT = 60 / BPM
E = BEAT / 2  # eighth

def pluck(midi, seconds, amp):
    freq = 440 * 2 ** ((midi - 69) / 12)
    period = max(2, int(round(RATE / freq)))
    buf = [random.uniform(-1, 1) for _ in range(period)]
    out = []
    for i in range(int(seconds * RATE)):
        j = i % period
        out.append(buf[j] * amp)
        buf[j] = 0.997 * 0.5 * (buf[j] + buf[(j + 1) % period])
    return out

STR = [40, 45, 50, 55, 59, 64]
# (eighth index, string, fret, amp)
score = []
# Travis picking over C (x32010) and G (320003) and Am, 2 bars each, 4/4
shapes = {
    'C': {1: 3, 2: 2, 3: 0, 4: 1, 5: 0},
    'G': {0: 3, 1: 2, 2: 0, 3: 0, 4: 0, 5: 3},
    'Am': {1: 0, 2: 2, 3: 2, 4: 1, 5: 0},
    'Em': {0: 0, 1: 2, 2: 2, 3: 0, 4: 0, 5: 0},
}
travis = {
    'C': [(0, 1), (1, 4), (2, 2), (3, 5), (4, 1), (5, 3), (6, 2), (7, 4)],  # thumb strings 1/2 alternate
    'G': [(0, 0), (1, 4), (2, 2), (3, 5), (4, 0), (5, 3), (6, 2), (7, 4)],
    'Am': [(0, 1), (1, 3), (2, 2), (3, 4), (4, 1), (5, 5), (6, 2), (7, 3)],
    'Em': [(0, 0), (1, 3), (2, 2), (3, 4), (4, 0), (5, 5), (6, 2), (7, 3)],
}
t = 0
for name in ['C', 'C', 'G', 'G', 'Am', 'Am', 'Em', 'Em']:
    for k, s in travis[name]:
        thumb = k % 2 == 0
        score.append((t + k, s, shapes[name][s], 0.5 if thumb else 0.38))
    t += 8
# a melody with repeated notes over a pedal bass on every beat (thumb repeats the same note)
melody = [(64, 0), (64, 1), (67, 2), (67, 3), (69, 4), (67, 6), (64, 8), (62, 9), (60, 10), (60, 11), (62, 12), (64, 14)]
for k in range(0, 16, 2):
    score.append((t + k, 0, 0, 0.5))  # low E every beat
for p, k in melody:
    s = 5 if p >= 64 else 4
    score.append((t + k, s, p - STR[s], 0.42))
t += 16

total = int((t * E + 3) * RATE)
mix = [0.0] * total
notes = []
by_string = {}
for k, s, f, a in sorted(score):
    by_string.setdefault(s, []).append((k, f, a))
for s, plist in by_string.items():
    for i, (k, f, a) in enumerate(plist):
        start = k * E + random.uniform(-0.008, 0.008)
        end = (plist[i + 1][0] * E) if i + 1 < len(plist) else t * E + 2.5
        dur = min(end - start + 0.02, 3.0)
        notes.append({"pitch": STR[s] + f, "time": round(start, 4)})
        off = int(start * RATE)
        for j, v in enumerate(pluck(STR[s] + f, dur, a)):
            if off + j < total:
                mix[off + j] += v
peak = max(abs(v) for v in mix)
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", int(v / peak * 30000)) for v in mix))
notes.sort(key=lambda n: n["time"])
json.dump(notes, open(sys.argv[2], "w"))
print(len(notes), "notes,", round(t * E, 1), "s")
