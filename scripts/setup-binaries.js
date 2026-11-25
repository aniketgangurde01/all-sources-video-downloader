const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN_DIR = path.resolve(__dirname, '..', 'bin');
const IS_WIN = process.platform === 'win32';
const YTDLP_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const YTDLP_DEST = path.join(BIN_DIR, YTDLP_NAME);

function isOnPath(cmd) {
  try {
    const checker = IS_WIN ? 'where' : 'which';
    execFileSync(checker, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getDownloadUrl() {
  if (IS_WIN) {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  }
  if (process.platform === 'darwin') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  }
  return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tempPath = `${dest}.tmp`;
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer));
  if (!IS_WIN) {
    fs.chmodSync(tempPath, 0o755);
  }
  fs.renameSync(tempPath, dest);
}

async function ensureYtDlp({ force = false } = {}) {
  if (!force && isOnPath('yt-dlp')) {
    console.log('[setup] yt-dlp found on system PATH.');
    return 'yt-dlp';
  }
  if (!force && fs.existsSync(YTDLP_DEST)) {
    console.log(`[setup] yt-dlp found at ${YTDLP_DEST}`);
    return YTDLP_DEST;
  }

  const url = getDownloadUrl();
  console.log(`[setup] Downloading official yt-dlp binary from ${url}...`);
  await downloadFile(url, YTDLP_DEST);
  console.log(`[setup] Saved yt-dlp to ${YTDLP_DEST}`);
  return YTDLP_DEST;
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  ensureYtDlp({ force })
    .then((binPath) => {
      try {
        const version = execFileSync(binPath, ['--version'], { encoding: 'utf8' }).trim();
        console.log(`[setup] yt-dlp ready (version: ${version})`);
      } catch (err) {
        console.warn('[setup] Downloaded yt-dlp, but version check failed:', err.message);
      }
    })
    .catch((err) => {
      console.error('[setup] Error setting up yt-dlp:', err.message);
      process.exit(1);
    });
}

module.exports = { ensureYtDlp, YTDLP_DEST };
