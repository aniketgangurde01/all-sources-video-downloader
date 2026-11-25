const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateMediaUrl, isPathInside, formatBytes, formatDuration } = require('../src/utils');
const {
  buildDownloadArgs,
  parseProgressLine,
  friendlyYtDlpError,
  summarizeFormats,
} = require('../src/ytdlp');
const { createApp } = require('../src/server');

describe('utils', () => {
  it('validates public http/https URLs and rejects unsafe schemes or private hosts', () => {
    assert.equal(validateMediaUrl('https://example.com/watch?v=123'), 'https://example.com/watch?v=123');
    assert.throws(() => validateMediaUrl(''), /valid URL/i);
    assert.throws(() => validateMediaUrl('file:///C:/Windows/win.ini'), /http:\/\/ and https:\/\//i);
    assert.throws(() => validateMediaUrl('http://localhost:3000/test'), /not allowed/i);
    assert.throws(() => validateMediaUrl('http://127.0.0.1/admin'), /not allowed/i);
    assert.throws(() => validateMediaUrl('http://192.168.1.10/stream'), /not allowed/i);
  });

  it('guards against directory traversal via isPathInside', () => {
    const base = path.resolve('C:/downloads');
    assert.equal(isPathInside(base, path.join(base, 'video.mp4')), true);
    assert.equal(isPathInside(base, base), false);
    assert.equal(isPathInside(base, path.join(base, '..', 'secret.txt')), false);
  });

  it('formats bytes and durations cleanly', () => {
    assert.equal(formatBytes(0), '—');
    assert.equal(formatBytes(1024 * 1024 * 5), '5.0 MB');
    assert.equal(formatDuration(125), '2:05');
    assert.equal(formatDuration(3665), '1:01:05');
  });
});

describe('ytdlp helpers', () => {
  it('builds safe download arguments for presets and custom formats', () => {
    const args = buildDownloadArgs({
      url: 'https://example.com/video',
      preset: '1080p',
      outputDir: 'C:\\downloads',
      jobId: '12345678-abcd-ef00',
      ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
    });

    assert.ok(args.includes('--no-playlist'));
    assert.ok(args.includes('--ffmpeg-location'));
    assert.ok(args.includes('bv*[height<=1080]+ba/b[height<=1080]/b'));
    assert.equal(args[args.length - 1], 'https://example.com/video');

    const audioArgs = buildDownloadArgs({
      url: 'https://example.com/audio',
      preset: 'audio_mp3',
      outputDir: 'C:\\downloads',
      jobId: '12345678-abcd-ef00',
    });
    assert.ok(audioArgs.includes('--audio-format'));
    assert.ok(audioArgs.includes('mp3'));

    assert.throws(
      () =>
        buildDownloadArgs({
          url: 'https://example.com/video',
          formatId: '137; rm -rf /',
          outputDir: 'C:\\downloads',
          jobId: '12345678',
        }),
      /Invalid format ID/
    );
  });

  it('parses yt-dlp progress, merger, and final file lines', () => {
    const prog = parseProgressLine('PROGRESS|downloading|524288|1048576|NA|262144|2');
    assert.deepEqual(prog, {
      type: 'progress',
      status: 'downloading',
      downloadedBytes: 524288,
      totalBytes: 1048576,
      speedBytes: 262144,
      etaSeconds: 2,
      percent: 50,
    });

    const merger = parseProgressLine('[Merger] Merging formats into "video.mp4"');
    assert.deepEqual(merger, { type: 'postprocessing' });

    const finalLine = parseProgressLine('FINAL_FILE:C:\\downloads\\video.mp4');
    assert.deepEqual(finalLine, {
      type: 'final_file',
      filePath: 'C:\\downloads\\video.mp4',
    });
  });

  it('filters out DRM and storyboard formats in summarizeFormats', () => {
    const formats = summarizeFormats([
      { format_id: 'sb0', ext: 'mhtml', vcodec: 'images' },
      { format_id: 'drm1', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', has_drm: true, height: 1080 },
      { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30 },
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', tbr: 128 },
    ]);
    assert.equal(formats.length, 2);
    assert.equal(formats[0].formatId, '137');
    assert.equal(formats[1].formatId, '140');
  });

  it('maps DRM and private errors to friendly messages', () => {
    assert.match(friendlyYtDlpError('ERROR: This video is DRM protected'), /DRM-protected/i);
    assert.match(friendlyYtDlpError('ERROR: Unsupported URL: https://x.test'), /not supported/i);
    assert.match(friendlyYtDlpError('ERROR: Sign in to confirm you are not a bot'), /authentication/i);
  });
});

describe('HTTP API', () => {
  let server;
  let baseUrl;
  let tempRoot;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-test-'));
    const created = createApp({
      downloadsDir: path.join(tempRoot, 'downloads'),
      dataDir: path.join(tempRoot, 'data'),
    });
    server = created.server;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports engine readiness on /api/health', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.engine.ytdlpReady, true);
    assert.equal(data.engine.ffmpegReady, true);
  });

  it('rejects invalid URLs on /api/inspect and /api/downloads', async () => {
    const inspectRes = await fetch(`${baseUrl}/api/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/nope' }),
    });
    assert.equal(inspectRes.status, 400);

    const dlRes = await fetch(`${baseUrl}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    assert.equal(dlRes.status, 400);
  });

  it('returns empty list initially and 404 for unknown job cancel', async () => {
    const listRes = await fetch(`${baseUrl}/api/downloads`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.deepEqual(listData.jobs, []);

    const cancelRes = await fetch(`${baseUrl}/api/downloads/nonexistent/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 404);
  });
});
