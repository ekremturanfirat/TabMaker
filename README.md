# TabMaker

Paste a song link, or upload an audio/video file, and get guitar tab.

**Try it in the browser (upload a file):** https://ekremturanfirat.com/tabmaker/

## Install the app (Windows)

The app also takes song links.

1. [Download TabMaker](https://github.com/ekremturanfirat/tabmaker/archive/refs/heads/main.zip),
   then right-click the zip → **Extract All** (for example into Documents).
2. Open the **tabmaker-main** folder and double-click **Start TabMaker**.
   If Windows says "Windows protected your PC", click **More info** → **Run anyway** (only once).
   The first time it may install Python and Deno — click **Yes** if Windows asks.
3. TabMaker opens in your browser at http://localhost:8000. To stop it, close the black **TabMaker** window.

More in [How to use.txt](How%20to%20use.txt). How it works and how to build it: [app/README.md](app/README.md).

Only use songs you have the right to use.

## License

Copyright © Ekrem Turan Fırat. TabMaker is licensed under the
[CERN Open Hardware Licence Version 2 – Strongly Reciprocal](LICENSE) (CERN-OHL-S v2).

The note model in `app/public/model/` is Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch-ts),
under its own [Apache 2.0 licence](app/public/model/LICENSE).

Made by [Ekrem Turan Fırat](https://ekremturanfirat.com/).
