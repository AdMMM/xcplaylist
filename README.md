# XCPlaylist

A fast, ad-free IPTV player for macOS and Windows with Xtream Codes API support. Built with Electron and Express.

## Download

Grab the latest installer from the [Releases page](https://github.com/AdMMM/xcplaylist/releases):

| Platform | File |
|----------|------|
| **macOS** (Apple Silicon) | `XCPlaylist-x.x.x-arm64.dmg` |
| **Windows** (64-bit) | `XCPlaylist Setup x.x.x.exe` |

### Windows: Smart App Control / SmartScreen blocking the installer?

Because the app isn't code-signed, Windows may block it. Two options:

**Option A — Unblock the download:**
1. Right-click the downloaded `.exe` → **Properties**
2. At the bottom, check **Unblock** → **Apply** → **OK**
3. Run the installer

**Option B — Run from source (bypasses all signing issues):**
```bash
git clone https://github.com/AdMMM/xcplaylist.git
cd xcplaylist
npm install
npm run electron
```
This runs the app directly — no installer, no signing warnings. Requires [Node.js 18+](https://nodejs.org/).

### macOS: "App is damaged" or "cannot be opened"

Right-click the app → **Open** (instead of double-clicking). macOS will ask to confirm — click **Open**. This only happens the first time.

## Features

- **Live TV, Movies & Series** — browse categories, search, and play
- **HEVC/H.265 support** — via mpegts.js for live streams
- **HLS fallback** — via HLS.js for H.264 streams
- **Automatic audio fix** — detects unsupported 5.1/Atmos audio (AC3, EAC3, DTS) and transcodes to AAC via bundled FFmpeg
- **EPG** — programme guide with reminder notifications
- **Continue Watching** — resume VOD/series from where you left off
- **Channel Zapping** — arrow keys to flip through live channels
- **Picture-in-Picture** — float video above other windows
- **Watch History** — grouped by date
- **Favorites** — star any channel, movie, or series
- **Format Cycling** — click the format icon to switch between TS, HLS, MP4, and AAC Fix
- **Stream Quality Indicator** — resolution and buffer health
- **Auto-hide Controls** — controls and cursor fade after 10s of inactivity
- **Keyboard Shortcuts** — space (play/pause), f (fullscreen), m (mute), p (PiP), arrows (seek/zap), Escape (close)

## Run from Source

```bash
# Clone the repo
git clone https://github.com/AdMMM/xcplaylist.git
cd xcplaylist

# Install dependencies
npm install

# Run as Electron desktop app
npm run electron

# Or run in browser (http://localhost:3000)
npm start

# Or run in dev mode with auto-reload
npm run dev
```

## Build Installers

```bash
# Build macOS DMG (must be on macOS)
npm run dist:mac

# Build Windows installer (works from macOS or Windows)
npm run dist:win

# Build both
npm run dist:all
```

Installers are output to the `dist/` folder.

## Project Structure

```
xcplaylist/
  electron.js              # Electron main process (platform-aware)
  server.js                # Express backend (XC API proxy, stream proxy, FFmpeg transcoding)
  scripts/
    download-ffmpeg.js     # Downloads platform-specific FFmpeg for builds
  build/
    icon.png               # App icon (1024x1024, auto-converted to .icns/.ico)
  public/
    index.html             # Single-page app shell
    css/style.css          # Styles (with Windows platform overrides)
    js/
      api.js               # XC API client
      player.js            # Video player (mpegts.js + HLS.js + native)
      epg.js               # EPG data handling
      app.js               # Main app controller
```

## How It Works

The Express server proxies all Xtream Codes API calls and streams to avoid CORS issues. Live streams use MPEG-TS format piped through a server-side proxy. VOD supports range requests for seeking. HLS manifests are rewritten to route segments through the proxy.

When the app detects unsupported audio codecs (AC3, EAC3/Atmos, DTS), it automatically switches to server-side FFmpeg transcoding — the audio is converted to AAC stereo while video passes through untouched.

## Requirements

- [Node.js 18+](https://nodejs.org/) (for running from source)
- An Xtream Codes compatible IPTV subscription

## License

MIT
