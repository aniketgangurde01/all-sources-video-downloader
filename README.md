# All-Sources Video Downloader

A local web application for inspecting and downloading publicly accessible, non-DRM videos and audio from 1,000+ supported platforms and direct streams (`.mp4`, `.m3u8`, etc.) using `yt-dlp` and `ffmpeg`.

## Features
- **Single URL & Playlist Inspection**: Preview title, thumbnail, uploader, duration, and available formats before downloading.
- **Quality Presets & Exact Format Picker**: Download in Best MP4, 4K (2160p), 1080p, 720p, 480p, 360p, MP3, M4A, or any specific format ID.
- **Batch Queue**: Paste multiple URLs at once to queue concurrent downloads.
- **Live Progress via WebSocket**: Real-time percentage, transfer speed, ETA, and status updates.
- **Local File Management**: Save files via browser, reveal in Windows Explorer, retry failed jobs, or clear finished history.

## Running Locally

```bash
npm install
npm run setup-bin
npm start
```

Then open **http://127.0.0.1:4567** in your browser.

Downloaded files are saved to `./downloads`.

## Running Tests

```bash
npm test
```

> **Note**: Only publicly accessible, non-DRM-protected media streams are supported.
