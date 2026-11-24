"""TabMaker server: serves the TabMaker page and fetches audio from song links.

Normally started by double-clicking "Start TabMaker.bat". It opens http://localhost:8000 in the browser.

Only this computer's own TabMaker page can use it:
  - it listens on 127.0.0.1 only (not reachable from other computers)
  - requests must be addressed to localhost (blocks DNS-rebinding tricks)
  - /api/ calls must carry the X-TabMaker header, which other websites can't send
    without the browser asking this server first (and it never says yes)
"""
import hashlib
import json
import mimetypes
import os
import shutil
import sys
import threading
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yt_dlp

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"  # downloaded audio; never shared
CACHE = DATA / "cache"
PORT = int(os.environ.get("PORT", 8000))
PAGE = f"http://localhost:{PORT}/"
LOCAL_HOSTS = {f"localhost:{PORT}", f"127.0.0.1:{PORT}"}
MAX_SECONDS = 20 * 60  # refuse videos longer than 20 minutes

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("audio/webm", ".webm")
mimetypes.add_type("audio/ogg", ".opus")


YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}
SHARE_PARAMS = {"si", "feature"}  # added when a link is shared; the same song without them


def song_url(url):
    """The link of the song itself: a YouTube video opened from a mix or a playlist
    (&list=...&start_radio=1), shared (?si=) or at a time (&t=) is the same song, so it is fetched once."""
    parts = urllib.parse.urlsplit(url)
    host = parts.netloc.lower()
    query = urllib.parse.parse_qs(parts.query)
    if host in YOUTUBE_HOSTS and parts.path == "/watch" and query.get("v"):
        return f"https://www.youtube.com/watch?v={query['v'][0]}"
    if host in {"youtu.be", "www.youtu.be"} and parts.path.strip("/"):
        return f"https://www.youtube.com/watch?v={parts.path.strip('/').split('/')[0]}"
    kept = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True) if k not in SHARE_PARAMS]
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(kept), ""))


def cached(folder):
    meta_file = folder / "meta.json"
    if meta_file.exists():
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        if (folder / meta["file"]).exists():
            return folder / meta["file"], meta
    return None


def fetch_audio(url):
    """Download the best audio-only stream of a video link, cached by the song's link."""
    url = song_url(url)
    folder = CACHE / hashlib.sha1(url.encode()).hexdigest()[:16]
    hit = cached(folder)
    if hit:
        return hit

    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir(parents=True)
    opts = {
        # m4a/webm audio decodes in every modern browser, so no ffmpeg is needed
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
        "outtmpl": str(folder / "audio.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "js_runtimes": {"deno": {}, "node": {}},  # some sites need one of these; the start script installs Deno if neither exists
        "match_filter": yt_dlp.utils.match_filter_func(f"duration < {MAX_SECONDS}"),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = [p for p in folder.iterdir() if p.name.startswith("audio.")]
    if not files:
        raise RuntimeError("No audio was downloaded (video too long, private, or unsupported).")
    meta = {
        "file": files[0].name,
        "title": info.get("title") or "Untitled",
        "duration": info.get("duration"),
        "uploader": info.get("uploader"),
    }
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return files[0], meta


def fetch_video(url):
    """Download the picture of a video link (no sound, small: enough to see the player's hands),
    kept next to its audio. H.264 mp4 plays in every browser."""
    url = song_url(url)
    folder = CACHE / hashlib.sha1(url.encode()).hexdigest()[:16]
    found = [p for p in folder.glob("video.*") if not p.name.endswith(".part")]
    if found:
        return found[0]
    folder.mkdir(parents=True, exist_ok=True)
    opts = {
        "format": "bestvideo[height<=480][vcodec^=avc1][ext=mp4]/bestvideo[height<=480][ext=mp4]/bestvideo[height<=720][ext=mp4]",
        "outtmpl": str(folder / "video.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "js_runtimes": {"deno": {}, "node": {}},
        "match_filter": yt_dlp.utils.match_filter_func(f"duration < {MAX_SECONDS}"),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.extract_info(url, download=True)
    found = [p for p in folder.glob("video.*") if not p.name.endswith(".part")]
    if not found:
        raise RuntimeError("This link has no video picture TabMaker can use.")
    return found[0]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.headers.get("Host") not in LOCAL_HOSTS:
            return self.send_error(403)
        parts = urllib.parse.urlsplit(self.path)
        if parts.path.startswith("/api/"):
            origin = self.headers.get("Origin")
            if (origin and origin.rstrip("/") not in {f"http://{h}" for h in LOCAL_HOSTS}) or not self.headers.get("X-TabMaker"):
                return self.send_json(403, {"error": "Only the TabMaker page on this computer can use this."})
        if parts.path == "/api/ping":
            return self.send_json(200, {"ok": True})
        if parts.path == "/api/audio":
            return self.send_audio(urllib.parse.parse_qs(parts.query).get("url", [""])[0])
        if parts.path == "/api/video":
            return self.send_video(urllib.parse.parse_qs(parts.query).get("url", [""])[0])
        return super().do_GET()

    def send_video(self, url):
        if not url.startswith(("http://", "https://")):
            return self.send_json(400, {"error": "Please paste a full link starting with http:// or https://"})
        try:
            path = fetch_video(url)
        except Exception as exc:  # yt-dlp raises many different error types
            msg = str(exc).replace("\x1b[0;31mERROR:\x1b[0m ", "").replace("ERROR: ", "")
            return self.send_json(502, {"error": msg[:500]})
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_audio(self, url):
        if not url.startswith(("http://", "https://")):
            return self.send_json(400, {"error": "Please paste a full link starting with http:// or https://"})
        try:
            path, meta = fetch_audio(url)
        except Exception as exc:  # yt-dlp raises many different error types
            msg = str(exc).replace("\x1b[0;31mERROR:\x1b[0m ", "").replace("ERROR: ", "")
            return self.send_json(502, {"error": msg[:500]})
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Title", urllib.parse.quote(meta["title"]))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep the window calm for non-technical users; errors still reach the page


class Server(ThreadingHTTPServer):
    # on Windows, address reuse would let a second copy share the port silently
    allow_reuse_address = sys.platform != "win32"


if __name__ == "__main__":
    # "--open" (double-click "Start TabMaker"): open the TabMaker page
    should_open = "--open" in sys.argv
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        print("TabMaker is already running - opening it.")
        if should_open:
            webbrowser.open(PAGE)
        sys.exit(0)

    print("=" * 60)
    print("  TabMaker is running:  " + PAGE)
    print("  Keep this window open while you use TabMaker.")
    print("  Close this window to stop it.")
    print("=" * 60, flush=True)
    if should_open:
        threading.Timer(0.5, webbrowser.open, [PAGE]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
