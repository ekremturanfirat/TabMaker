# TabMaker

Paste a song link, or upload an audio/video file, and get guitar tab.

## Run

Users: double-click `Start TabMaker.bat` in the folder above (see `How to use.txt`).
It installs Python/Deno if missing, updates yt-dlp, starts `server.py`,
and opens the TabMaker page at http://localhost:8000.

Why a local app and not only the website: a static website can't fetch a song from a link, so links
work in the app, and the website (https://ekremturanfirat.com/TabMaker/) takes uploaded files.

Developers:

```
npm install
npm run build        # bundles public/app.js and copies the model to public/model
npm run build:site   # writes the website copy into ../_site (GitHub Actions publishes it on every push to main)
python server.py     # local page at http://localhost:8000
```

`data/` holds downloaded audio. It is never shared or published.

## How it works

1. **Download** – `server.py` uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) to fetch the audio of a link (cached in `cache/`).
2. **Listen** – in the browser, Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch-ts) model finds the notes.
3. **Clean** – overtones, re-detected ringing notes and faint notes (open strings ringing along) are removed
   (`removeGhostNotes` in `src/tab.js`); a note with its own clear onset is kept even if it looks like an overtone,
   unless that octave comes with nearly every pluck of its note around that time (then it is the string's own sound).
   A note whose own pitch gets clearly louder at its start (`pitchJump` in `src/app.js`) was plucked, so it is never
   dropped as an echo or a faint ring-along note.
4. **Finger** – each note/chord gets a string, fret and fretting finger. A dynamic-programming pass
   (`assignFrets`) follows the left hand itself: the index finger sits at a fret and fingers 1-4 cover
   the next four, open strings leave it free, and moving it costs more the farther and faster it has
   to go, so the hand stays in position instead of jumping around the neck.
5. **Rhythm** – the overall tempo is estimated (`estimateTempo`), then every beat is tracked so the grid
   follows a player who speeds up or slows down (`trackBeats`, dynamic programming after Ellis 2007).
   The time signature (3/4, 4/4 or 6/8) is guessed from where the bass notes and chords fall, and bar 1 is
   found beat by beat, re-syncing where the accents move (a bar with a beat more or less, a pause), so a bar
   can come out shorter or longer (`findBars`). The struck bass notes decide where the accents can't: 3/4
   when the bass comes on one beat of every three far more than on the others (a waltz whose chords ring
   as loud as its bass), and 6/8, counted in eighths, when it comes on one beat of every six and the notes
   hardly split the beats. A beat the notes split in three (`splitBeats`) is a dotted quarter of 6/8,
   counted in its thirds, when it is slow enough (♩. ≤ 95) and the beats don't group in threes; otherwise it
   is a quarter played in triplets, and the grid is in triplets.
   Notes are snapped to a 16th/8th grid along the beats (`quantize`); where more than a few notes would move
   audibly (80 ms+) to fit it, the grid is made twice as fine. Any signature can also be picked by hand.
6. **Techniques** – hammer-ons/pull-offs (`h` `p`), slides (`/` `\`), bends (`b`, `r`) and vibrato (`~`) are
   guessed from the sound (`findTechniques`, `techniqueMarks`): a note that follows a still-ringing one with no
   pick click in the audio is legato; pitch gliding through the notes in between is a slide or bend; a wobbling
   pitch curve is vibrato. Linked notes are kept on one string by the fingering pass.

Options (tuning, capo, melody/bass only, sensitivity, tempo…) re-run steps 3–6 instantly.

**Checking the tab against the song.** "Compare with the song" plays the tab offline with the same synth as
"Play the tab", runs Basic Pitch on that, and matches its notes with the song's (same pitch, onsets within
80 ms; fixed thresholds so scores compare across settings). It gives an overall score, colours each bar
number green / yellow / red, and lists per bar the song notes the tab misses, the tab notes the song doesn't
have, and right notes at the wrong time. "tab along" plays the tab quietly on top of the song.
Two kinds of notes count neither way, because the model can't tell them apart (`doubtful`): a quieter
octave / 12th starting with another note (overtone or played octave?), and a ringing note heard starting
again without getting louder (re-plucked or not?). Counting them made the score favour wrong tabs.
From the dev console: `await tabmaker.compare()` returns the same numbers. Use it before and after every
change to the tab engine; `tools/bench.js` runs it over several songs (see its header).

The hand view (`src/hands.js`) draws both hands in 3D with a small perspective camera: fingers as
shaded, tapering tubes (knuckle creases, nails when they face you) casting soft shadows on a rosewood
fretboard / spruce top, bronze-wound bass strings, sounding strings shaking. Slightly see-through:
the left hand as the player sees it looking down (fingers arched onto their strings, a flat index for
a barre, the thumb and palm behind the neck dashed), the right hand from the front (p ahead of i m a,
the finger that plucks follows through towards the palm). The left hand holds the whole chord shape
of an arpeggio, not only the note sounding (`heldShape` in `src/app.js`: neighbouring notes played in
the same position without moving a finger), and a line under it says how to hold the hands for the
passage (arpeggio, barre, chord, single notes). "hands" switches to the flat fretboard: the left hand
gliding to each position with numbered fingers and the right hand's p i m a on the plucked strings.
On screen, techniques are drawn as tab symbols (slur arcs, slide lines, bend arrows, vibrato waves);
the .txt export writes them as h p / \ b r ~.

## Files

- `server.py` – web server + `/api/audio?url=` download endpoint (only its own page can call it)
- `tools/build-site.mjs` – builds the upload-only website copy (`npm run build:site`, and `.github/workflows/pages.yml`)
- `src/app.js` – page logic (bundled to `public/app.js` with `npm run build`)
- `src/tab.js` – the tab engine
- `src/hands.js` – the 3D hand view
- `public/index.html` – the page
- `tools/make_test_audio.py` – makes a test WAV with known notes
- `tools/make_technique_audio.py` – makes a test WAV with a hammer-on, pull-off, slides, a bend and vibrato
- `tools/make_fingerstyle_audio.py` – makes a fingerstyle test WAV (Travis picking, pedal bass) + its true notes
- `tools/bench.js` – dev bench: compares the tab with the song over several songs, with diagnostics
- `tools/make_meter_audio.py` – makes test songs with a known time signature (6/8, 3/4, 4/4) for meter checks

## Limits

- Works best on solo guitar. In full-band mixes, vocals/bass/keys are heard as notes too.
- It hears pitches, not hands – the fingering is the most comfortable one, not necessarily the player's.
- Only download videos you have the right to use.
