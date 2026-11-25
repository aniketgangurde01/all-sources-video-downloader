const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { validateMediaUrl } = require('./utils');
const { getEngineStatus, inspectUrl } = require('./ytdlp');
const { DownloadManager } = require('./downloads');

function openInExplorer(targetPath, { selectFile = false } = {}) {
  if (process.platform === 'win32') {
    const args = selectFile ? ['/select,', targetPath] : [targetPath];
    execFile('explorer.exe', args, { windowsHide: true }, () => {});
    return;
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const openTarget = selectFile ? path.dirname(targetPath) : targetPath;
  execFile(cmd, [openTarget], () => {});
}

function createApp({
  downloadsDir = path.resolve(__dirname, '..', 'downloads'),
  dataDir = path.resolve(__dirname, '..', 'data'),
  publicDir = path.resolve(__dirname, '..', 'public'),
  maxConcurrent = 2,
} = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const manager = new DownloadManager({ downloadsDir, dataDir, maxConcurrent });

  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(publicDir));

  function broadcast(payload) {
    const msg = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        jobs: manager.listJobs(),
        engine: getEngineStatus(),
      })
    );
  });

  manager.on('update', (job) => broadcast({ type: 'job_update', job }));
  manager.on('remove', (id) => broadcast({ type: 'job_remove', id }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      engine: getEngineStatus(),
      downloadsDir: manager.downloadsDir,
    });
  });

  app.post('/api/inspect', async (req, res) => {
    try {
      const url = validateMediaUrl(req.body?.url);
      const allowPlaylist = Boolean(req.body?.allowPlaylist);
      const metadata = await inspectUrl(url, { allowPlaylist });
      res.json(metadata);
    } catch (err) {
      const status = /invalid|enter a valid|not allowed|only http/i.test(err.message) ? 400 : 422;
      res.status(status).json({ error: err.message });
    }
  });

  app.get('/api/downloads', (_req, res) => {
    res.json({ jobs: manager.listJobs() });
  });

  app.post('/api/downloads', (req, res) => {
    try {
      const body = req.body || {};
      if (Array.isArray(body.urls)) {
        const cleaned = body.urls.map((u) => validateMediaUrl(u));
        if (cleaned.length === 0) {
          return res.status(400).json({ error: 'Provide at least one valid URL.' });
        }
        const jobs = cleaned.map((url) =>
          manager.enqueue({
            url,
            preset: body.preset || 'best',
            allowPlaylist: Boolean(body.allowPlaylist),
          })
        );
        return res.status(201).json({ jobs });
      }

      const url = validateMediaUrl(body.url);
      const job = manager.enqueue({
        url,
        title: typeof body.title === 'string' ? body.title.slice(0, 240) : null,
        thumbnail: typeof body.thumbnail === 'string' ? body.thumbnail : null,
        extractor: typeof body.extractor === 'string' ? body.extractor.slice(0, 60) : null,
        preset: body.preset || 'best',
        formatId: body.formatId || null,
        allowPlaylist: Boolean(body.allowPlaylist),
      });
      return res.status(201).json({ job });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/downloads/:id/cancel', (req, res) => {
    const job = manager.cancel(req.params.id);
    if (!job) return res.status(404).json({ error: 'Download job not found.' });
    return res.json({ job });
  });

  app.post('/api/downloads/:id/retry', (req, res) => {
    const job = manager.retry(req.params.id);
    if (!job) return res.status(404).json({ error: 'Download job not found.' });
    return res.json({ job });
  });

  app.post('/api/downloads/clear', (_req, res) => {
    const removed = manager.clearCompleted();
    res.json({ removed });
  });

  app.delete('/api/downloads/:id', (req, res) => {
    const deleteFile = req.query.deleteFile === 'true';
    const removed = manager.remove(req.params.id, { deleteFile });
    if (!removed) return res.status(404).json({ error: 'Download job not found.' });
    return res.json({ ok: true });
  });

  app.get('/api/downloads/:id/file', (req, res) => {
    const filePath = manager.getSafeFilePath(req.params.id);
    if (!filePath) {
      return res.status(404).json({ error: 'Downloaded file not found on disk.' });
    }
    return res.download(filePath);
  });

  app.post('/api/downloads/:id/reveal', (req, res) => {
    const filePath = manager.getSafeFilePath(req.params.id);
    if (!filePath) {
      return res.status(404).json({ error: 'Downloaded file not found on disk.' });
    }
    openInExplorer(filePath, { selectFile: true });
    return res.json({ ok: true });
  });

  app.post('/api/open-folder', (_req, res) => {
    openInExplorer(manager.downloadsDir, { selectFile: false });
    res.json({ ok: true, downloadsDir: manager.downloadsDir });
  });

  return { app, server, wss, manager };
}

if (require.main === module) {
  const fixedPort = process.env.PORT ? Number(process.env.PORT) : null;
  const HOST = process.env.HOST || '127.0.0.1';
  const { server } = createApp();
  let port = fixedPort || 4567;
  let attempts = 0;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !fixedPort && attempts < 10) {
      attempts += 1;
      port += 1;
      server.listen(port, HOST);
      return;
    }
    console.error(`Failed to start server on ${HOST}:${port}:`, err.message);
    process.exit(1);
  });

  server.on('listening', () => {
    const addr = server.address();
    console.log(`All-Sources Video Downloader running at http://${HOST}:${addr.port}`);
  });

  server.listen(port, HOST);
}

module.exports = { createApp };
