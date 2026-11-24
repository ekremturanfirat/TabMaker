"""Make a test file with known playing techniques (one string-like voice whose pitch can move).

python tools/make_technique_audio.py public/test-tech.wav
Prints what the tab should show, so technique detection can be checked.
"""
import math
import random
import struct
import sys
import wave

RATE = 22050


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


# Each phrase is picked once; then the pitch moves without picking again.
# (start s, length s, [(time from start, kind, midi)])  kind: pick | jump (h/p) | glide (slide/bend) | vib
PHRASES = [
    (0.0, 1.0, [(0, "pick", 57), (0.3, "jump", 59), (0.6, "jump", 57)]),  # 57h59p57
    (1.2, 1.0, [(0, "pick", 60), (0.3, "glide", 64)]),  # slide up 4 frets
    (2.4, 1.0, [(0, "pick", 64), (0.3, "glide", 62)]),  # slide down 2 frets
    (3.6, 1.3, [(0, "pick", 62), (0.2, "glide", 64), (0.8, "glide", 62)]),  # bend up a tone, release
    (5.2, 1.3, [(0, "pick", 64), (0.15, "vib", 64)]),  # vibrato
    (6.8, 0.3, [(0, "pick", 60)]),  # two picked notes: no technique
    (7.1, 1.0, [(0, "pick", 62)]),
]

total = int(9 * RATE)
mix = [0.0] * total
for start, length, moves in PHRASES:
    phase = 0.0
    n = int(length * RATE)
    pitch = moves[0][2]
    for i in range(n):
        t = i / RATE
        vib = 0.0
        amp_boost = 1.0
        for when, kind, midi in moves:
            if t < when:
                break
            if kind in ("pick", "jump"):
                pitch = midi
                if kind == "jump" and t - when < 0.02:
                    amp_boost = 1.1
            elif kind == "glide":
                # 70 ms glide from the previous pitch
                k = min(1.0, (t - when) / 0.07)
                base = next(m for w, kk, m in reversed(moves) if w < when)
                pitch = base + (midi - base) * k
            elif kind == "vib":
                vib = 0.4 * math.sin(2 * math.pi * 6 * (t - when))
        f = hz(pitch + vib)
        phase += 2 * math.pi * f / RATE
        env = math.exp(-t / 1.0) * amp_boost
        v = sum(math.sin(k * phase) / k ** 1.4 * math.exp(-t * k * 0.6) for k in range(1, 9))
        if t < 0.01:
            v += random.uniform(-1, 1) * (1 - t / 0.01)  # pick noise
        fade = min(1.0, (n - i) / (0.01 * RATE))
        if start * RATE + i < total:
            mix[int(start * RATE) + i] += 0.3 * v * env * fade

peak = max(abs(v) for v in mix)
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", int(v / peak * 30000)) for v in mix))

print("expected (MIDI): 57h59p57 | 60/64 | 64\\62 | 62b64r62 | 64~ | 60 62 (no marks)")
print('Check with Techniques = "Show more": the model hears these synthetic hammer-ons and slides as struck,')
print('so "Show the clear ones" only keeps the bend and the vibrato.')
