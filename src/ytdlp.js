const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { formatBytes, formatDuration } = require('./utils');

const IS_WIN = process.platform === 'win32';
const LOCAL_YTDLP = path.resolve(__dirname, '..', 'bin', IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');

const PRESET_CONFIGS = {
  best: {
    label: 'Best Quality (MP4)',
    args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
  },
  '2160p': {
    label: '4K Ultra HD (2160p MP4)',
    args: ['-f', 'bv*[height<=2160]+ba/b[height<=2160]/b', '--merge-output-format', 'mp4'],
  },
  '1080p': {
    label: 'Full HD (1080p MP4)',
    args: ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4'],
  },
  '720p': {
    label: 'HD (720p MP4)',
    args: ['-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4'],
  },
  '480p': {
    label: 'SD (480p MP4)',
    args: ['-f', 'bv*[height<=480]+ba/b[height<=480]/b', '--merge-output-format', 'mp4'],
  },
  '360p': {
    label: 'Compact (360p MP4)',
    args: ['-f', 'bv*[height<=360]+ba/b[height<=360]/b', '--merge-output-format', 'mp4'],
  },
  audio_mp3: {
    label: 'Audio Only (MP3)',
    args: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  },
  audio_m4a: {
    label: 'Audio Only (M4A)',
    args: ['-x', '--audio-format', 'm4a', '--audio-quality', '0'],
  },
};

function commandExists(cmd) {
  try {
    execFileSync(IS_WIN ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveYtDlpPath() {
  if (fs.existsSync(LOCAL_YTDLP)) return LOCAL_YTDLP;
  if (commandExists('yt-dlp')) return 'yt-dlp';
  return null;
}

function resolveFfmpegPath() {
  if (commandExists('ffmpeg')) return 'ffmpeg';
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch {
    // ffmpeg-static optional fallback
  }
  return null;
}

function getEngineStatus() {
  const ytdlpPath = resolveYtDlpPath();
  const ffmpegPath = resolveFfmpegPath();
  let ytdlpVersion = null;

  if (ytdlpPath) {
    try {
      ytdlpVersion = execFileSync(ytdlpPath, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    } catch {
      ytdlpVersion = 'unknown';
    }
  }

  return {
    ytdlpReady: Boolean(ytdlpPath),
    ytdlpPath,
    ytdlpVersion,
    ffmpegReady: Boolean(ffmpegPath),
    ffmpegPath,
  };
}

function friendlyYtDlpError(stderrText) {
  const msg = (stderrText || '').trim();
  if (/drm/i.test(msg)) {
    return 'This stream appears to be DRM-protected. Only public, non-DRM media is supported.';
  }
  if (/unsupported url/i.test(msg)) {
    return 'This URL is not supported by yt-dlp or does not contain a downloadable media stream.';
  }
  if (/private video|sign in|login|cookies/i.test(msg)) {
    return 'This media requires authentication or is private. Only publicly accessible streams are supported.';
  }
  if (/video unavailable|404|not found/i.test(msg)) {
    return 'Media not found or unavailable at the provided URL.';
  }
  const lines = msg
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'))
    .map((l) => l.replace(/^ERROR:\s*/, ''));
  return lines[0] || msg || 'Failed to process URL.';
}

function summarizeFormats(rawFormats) {
  if (!Array.isArray(rawFormats)) return [];

  const usable = rawFormats.filter((f) => {
    if (!f || !f.format_id) return false;
    if (f.has_drm) return false;
    if (f.ext === 'mhtml' || f.vcodec === 'images') return false;
    return f.vcodec !== 'none' || f.acodec !== 'none';
  });

  const mapped = usable.map((f) => {
    const hasVideo = f.vcodec && f.vcodec !== 'none';
    const hasAudio = f.acodec && f.acodec !== 'none';
    const size = f.filesize || f.filesize_approx || null;
    const height = f.height || null;
    const fps = f.fps ? Math.round(f.fps) : null;
    const kind = hasVideo && hasAudio ? 'video+audio' : hasVideo ? 'video' : 'audio';

    const parts = [];
    if (height) parts.push(`${height}p${fps && fps > 30 ? fps : ''}`);
    else if (f.resolution && f.resolution !== 'audio only') parts.push(f.resolution);
    else if (kind === 'audio') parts.push('Audio');

    parts.push((f.ext || 'unknown').toUpperCase());
    if (kind === 'video') parts.push('(auto-merged w/ audio)');
    if (f.tbr) parts.push(`${Math.round(f.tbr)}kbps`);
    if (size) parts.push(formatBytes(size));

    return {
      formatId: String(f.format_id),
      ext: f.ext || 'unknown',
      kind,
      height,
      fps,
      tbr: f.tbr || 0,
      filesize: size,
      label: parts.join(' • '),
    };
  });

  mapped.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  return mapped.slice(0, 40);
}

/**
 * Inspects a URL via yt-dlp --dump-single-json without downloading.
 */
function inspectUrl(url, { allowPlaylist = false, timeoutMs = 45000 } = {}) {
  const ytdlpPath = resolveYtDlpPath();
  if (!ytdlpPath) {
    return Promise.reject(
      new Error('yt-dlp binary is not installed. Run "npm run setup-bin" to download it.')
    );
  }

  const args = [
    '--dump-single-json',
    '--no-warnings',
    '--skip-download',
    '--no-check-certificates',
    ...(allowPlaylist ? ['--flat-playlist'] : ['--no-playlist']),
    url,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error('Timed out while inspecting URL. The source may be slow or unreachable.'));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to launch yt-dlp: ${err.message}`));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0 || !stdout.trim()) {
        reject(new Error(friendlyYtDlpError(stderr)));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const isPlaylist = info._type === 'playlist' && Array.isArray(info.entries);

        if (isPlaylist) {
          const entries = info.entries
            .filter(Boolean)
            .slice(0, 100)
            .map((entry, idx) => ({
              index: idx + 1,
              id: entry.id || String(idx + 1),
              title: entry.title || `Item ${idx + 1}`,
              duration: entry.duration || null,
              durationFormatted: formatDuration(entry.duration),
              url: entry.url || entry.webpage_url || null,
            }));

          resolve({
            isPlaylist: true,
            title: info.title || 'Playlist',
            uploader: info.uploader || info.channel || info.extractor_key || 'Unknown',
            extractor: info.extractor_key || info.extractor || 'Web',
            webpageUrl: info.webpage_url || url,
            thumbnail: info.thumbnails?.[info.thumbnails.length - 1]?.url || null,
            entryCount: info.playlist_count || entries.length,
            entries,
            formats: [],
            presets: Object.entries(PRESET_CONFIGS).map(([id, cfg]) => ({ id, label: cfg.label })),
          });
          return;
        }

        const formats = summarizeFormats(info.formats);
        resolve({
          isPlaylist: false,
          id: info.id || null,
          title: info.title || 'Untitled Media',
          uploader: info.uploader || info.channel || info.extractor_key || 'Unknown',
          extractor: info.extractor_key || info.extractor || 'Web',
          webpageUrl: info.webpage_url || url,
          thumbnail: info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url || null,
          duration: info.duration || null,
          durationFormatted: formatDuration(info.duration),
          viewCount: info.view_count || null,
          formats,
          presets: Object.entries(PRESET_CONFIGS).map(([id, cfg]) => ({ id, label: cfg.label })),
        });
      } catch (err) {
        reject(new Error(`Could not parse media metadata: ${err.message}`));
      }
    });
  });
}

function buildDownloadArgs({
  url,
  preset = 'best',
  formatId = null,
  outputDir,
  jobId,
  ffmpegPath = null,
  allowPlaylist = false,
}) {
  const args = [
    '--newline',
    '--no-warnings',
    '--no-part',
    '--progress-template',
    'download:PROGRESS|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print',
    'after_move:FINAL_FILE:%(filepath)s',
  ];

  if (IS_WIN) {
    args.push('--windows-filenames');
  }

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (!allowPlaylist) {
    args.push('--no-playlist');
    args.push('-o', path.join(outputDir, `%(title).120B [${jobId.slice(0, 8)}].%(ext)s`));
  } else {
    args.push('-o', path.join(outputDir, `%(playlist_title).60B [${jobId.slice(0, 8)}]`, '%(playlist_index)03d - %(title).100B.%(ext)s'));
  }

  if (formatId) {
    const cleanId = String(formatId).trim();
    if (!/^[a-zA-Z0-9._+-]+$/.test(cleanId)) {
      throw new Error('Invalid format ID.');
    }
    // Pair video-only format ID with best audio automatically when possible
    args.push('-f', `${cleanId}+ba/${cleanId}`);
  } else {
    const config = PRESET_CONFIGS[preset] || PRESET_CONFIGS.best;
    args.push(...config.args);
  }

  args.push(url);
  return args;
}

function toNumberOrNull(val) {
  if (!val || val === 'NA' || val === 'None') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function parseProgressLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('PROGRESS|')) {
    const [, status, dlStr, totalStr, estStr, speedStr, etaStr] = trimmed.split('|');
    const downloadedBytes = toNumberOrNull(dlStr) || 0;
    const totalBytes = toNumberOrNull(totalStr) || toNumberOrNull(estStr);
    const speedBytes = toNumberOrNull(speedStr);
    const etaSeconds = toNumberOrNull(etaStr);
    const percent =
      totalBytes && totalBytes > 0
        ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 1000) / 10)
        : null;

    return {
      type: 'progress',
      status: status || 'downloading',
      downloadedBytes,
      totalBytes,
      speedBytes,
      etaSeconds,
      percent,
    };
  }

  if (trimmed.startsWith('FINAL_FILE:')) {
    return {
      type: 'final_file',
      filePath: trimmed.slice('FINAL_FILE:'.length).trim(),
    };
  }

  if (trimmed.startsWith('[Merger]') || trimmed.startsWith('[ExtractAudio]') || trimmed.startsWith('[Fixup')) {
    return { type: 'postprocessing' };
  }

  return null;
}

module.exports = {
  PRESET_CONFIGS,
  resolveYtDlpPath,
  resolveFfmpegPath,
  getEngineStatus,
  friendlyYtDlpError,
  summarizeFormats,
  inspectUrl,
  buildDownloadArgs,
  parseProgressLine,
};
