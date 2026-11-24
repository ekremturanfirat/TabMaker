# TabMaker

Paste a song link, or upload an audio/video file, and get guitar tab.

If the song is a video of someone playing, TabMaker can also watch the player's fretting hand: mark the
neck once (click both ends of the nut and of the 12th fret wire), press **Follow the hand**, and the tab
puts the notes on the strings and frets where the player had them, not just the easiest ones.

**Try it in the browser (upload a file):** https://ekremturanfirat.com/TabMaker/

## Install the app (Windows)

The app also takes song links.

1. [Download TabMaker](https://github.com/ekremturanfirat/TabMaker/archive/refs/heads/main.zip),
   then right-click the zip → **Extract All** (for example into Documents).
2. Open the **TabMaker-main** folder and double-click **Start TabMaker**.
   If Windows says "Windows protected your PC", click **More info** → **Run anyway** (only once).
   The first time it may install Python and Deno — click **Yes** if Windows asks.
3. TabMaker opens in your browser at http://localhost:8000. To stop it, close the black **TabMaker** window.

More in [How to use.txt](How%20to%20use.txt). How it works and how to build it: [app/README.md](app/README.md).

Only use songs you have the right to use.

## License

Copyright © 2026 Ekrem Turan Fırat. TabMaker is free software under the
[GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later): you can use, study, change and
share it, and changed versions you share must stay under the same licence with their source code.

The note model in `app/public/model/` is Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch-ts),
under its own [Apache 2.0 licence](app/public/model/LICENSE). The hand model in `app/public/mediapipe/` is
Google's [MediaPipe](https://github.com/google-ai-edge/mediapipe) Hand Landmarker, also under the
[Apache 2.0 licence](app/public/mediapipe/LICENSE).

Made by [Ekrem Turan Fırat](https://ekremturanfirat.com/).
