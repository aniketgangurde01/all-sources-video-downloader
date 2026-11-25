const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { spawn, execFile } = require('node:child_process');
const {
  PRESET_CONFIGS,
  resolveYtDlpPath,
  resolveFfmpegPath,
  buildDownloadArgs,
  parseProgressLine,
  friendlyYtDlpError,
} = require('./ytdlp');
const { isPathInside } = require('./utils');

const IS_WIN = process.platform === 'win32';

class DownloadManager extends EventEmitter {
  constructor({ downloadsDir, dataDir, maxConcurrent = 2 }) {
    super();
    this.downloadsDir = path.resolve(downloadsDir);
    this.dataDir = path.resolve(dataDir);
    this.historyFile = path.join(this.dataDir, 'history.json');
    this.maxConcurrent = maxConcurrent;

    fs.mkdirSync(this.downloadsDir, { recursive: true });
    fs.mkdirSync(this.dataDir, { recursive: true });

    this.jobs = new Map();
    this.activeProcesses = new Map();
    this._loadHistory();
  }

  _loadHistory() {
    if (!fs.existsSync(this.historyFile)) return;
    try {
      const raw = fs.readFileSync(this.historyFile, 'utf8');
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;

      let changed = false;
      for (const item of list) {
        if (!item || !item.id) continue;
        if (item.status === 'queued' || item.status === 'downloading' || item.status === 'postprocessing') {
          item.status = 'canceled';
          item.error = 'Interrupted when server stopped';
          changed = true;
        }
        this.jobs.set(item.id, item);
      }
      if (changed) this._saveHistory();
    } catch {
      // Ignore corrupt history on startup
    }
  }

  _saveHistory() {
    const serialized = JSON.stringify(this.listJobs(), null, 2);
    const tmpFile = `${this.historyFile}.tmp`;
    fs.writeFileSync(tmpFile, serialized, 'utf8');
    fs.renameSync(tmpFile, this.historyFile);
  }

  _emitUpdate(job) {
    this.emit('update', this._publicJob(job));
  }

  _publicJob(job) {
    return {
      id: job.id,
      url: job.url,
      title: job.title,
      thumbnail: job.thumbnail,
      extractor: job.extractor,
      preset: job.preset,
      presetLabel: job.presetLabel,
      formatId: job.formatId,
      allowPlaylist: job.allowPlaylist,
      status: job.status,
      percent: job.percent,
      downloadedBytes: job.downloadedBytes,
      totalBytes: job.totalBytes,
      speedBytes: job.speedBytes,
      etaSeconds: job.etaSeconds,
      fileName: job.fileName,
      fileSize: job.fileSize,
      hasFile: Boolean(job.filePath && fs.existsSync(job.filePath)),
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  listJobs() {
    return Array.from(this.jobs.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((j) => this._publicJob(j));
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  enqueue({
    url,
    title = null,
    thumbnail = null,
    extractor = null,
    preset = 'best',
    formatId = null,
    allowPlaylist = false,
  }) {
    const id = crypto.randomUUID();
    const presetLabel = formatId
      ? `Format ${formatId}`
      : (PRESET_CONFIGS[preset]?.label || PRESET_CONFIGS.best.label);

    const job = {
      id,
      url,
      title: title || url,
      thumbnail,
      extractor: extractor || 'Web',
      preset: PRESET_CONFIGS[preset] ? preset : 'best',
      presetLabel,
      formatId: formatId || null,
      allowPlaylist: Boolean(allowPlaylist),
      status: 'queued',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      speedBytes: null,
      etaSeconds: null,
      filePath: null,
      fileName: null,
      fileSize: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    this.jobs.set(id, job);
    this._saveHistory();
    this._emitUpdate(job);
    this._pumpQueue();

    return this._publicJob(job);
  }

  _pumpQueue() {
    while (this.activeProcesses.size < this.maxConcurrent) {
      const nextJob = Array.from(this.jobs.values()).find((j) => j.status === 'queued');
      if (!nextJob) break;
      this._startJob(nextJob);
    }
  }

  _startJob(job) {
    const ytdlpPath = resolveYtDlpPath();
    if (!ytdlpPath) {
      job.status = 'error';
      job.error = 'yt-dlp binary is missing. Run "npm run setup-bin".';
      this._saveHistory();
      this._emitUpdate(job);
      return;
    }

    let args;
    try {
      args = buildDownloadArgs({
        url: job.url,
        preset: job.preset,
        formatId: job.formatId,
        outputDir: this.downloadsDir,
        jobId: job.id,
        ffmpegPath: resolveFfmpegPath(),
        allowPlaylist: job.allowPlaylist,
      });
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      this._saveHistory();
      this._emitUpdate(job);
      return;
    }

    job.status = 'downloading';
    job.error = null;
    job.percent = 0;
    this._saveHistory();
    this._emitUpdate(job);

    const child = spawn(ytdlpPath, args, { windowsHide: true });
    this.activeProcesses.set(job.id, child);

    let stdoutBuffer = '';
    let stderrText = '';
    let lastBroadcast = 0;
    const finalFiles = [];

    const handleLine = (line) => {
      const parsed = parseProgressLine(line);
      if (!parsed) return;

      if (parsed.type === 'progress') {
        job.downloadedBytes = parsed.downloadedBytes;
        job.totalBytes = parsed.totalBytes;
        job.speedBytes = parsed.speedBytes;
        job.etaSeconds = parsed.etaSeconds;
        if (parsed.percent !== null) job.percent = parsed.percent;

        const now = Date.now();
        if (now - lastBroadcast >= 200) {
          lastBroadcast = now;
          this._emitUpdate(job);
        }
      } else if (parsed.type === 'postprocessing') {
        job.status = 'postprocessing';
        job.percent = 100;
        job.speedBytes = null;
        job.etaSeconds = null;
        this._emitUpdate(job);
      } else if (parsed.type === 'final_file' && parsed.filePath) {
        finalFiles.push(parsed.filePath);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        handleLine(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString();
    });

    child.on('error', (err) => {
      this.activeProcesses.delete(job.id);
      if (job.status !== 'canceled') {
        job.status = 'error';
        job.error = `Failed to run yt-dlp: ${err.message}`;
        this._saveHistory();
        this._emitUpdate(job);
      }
      this._pumpQueue();
    });

    child.on('close', (code) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      this.activeProcesses.delete(job.id);

      if (job.status === 'canceled') {
        this._saveHistory();
        this._emitUpdate(job);
        this._pumpQueue();
        return;
      }

      if (code === 0) {
        const lastFile = finalFiles[finalFiles.length - 1] || null;
        if (lastFile && isPathInside(this.downloadsDir, lastFile) && fs.existsSync(lastFile)) {
          const stat = fs.statSync(lastFile);
          job.filePath = lastFile;
          job.fileName = path.basename(lastFile);
          job.fileSize = stat.size;
        }
        job.status = 'completed';
        job.percent = 100;
        job.speedBytes = null;
        job.etaSeconds = null;
        job.completedAt = new Date().toISOString();
      } else {
        job.status = 'error';
        job.error = friendlyYtDlpError(stderrText);
      }

      this._saveHistory();
      this._emitUpdate(job);
      this._pumpQueue();
    });
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (job.status === 'queued') {
      job.status = 'canceled';
      job.error = 'Canceled by user';
      this._saveHistory();
      this._emitUpdate(job);
      return this._publicJob(job);
    }

    const child = this.activeProcesses.get(id);
    if (child) {
      job.status = 'canceled';
      job.error = 'Canceled by user';
      job.speedBytes = null;
      job.etaSeconds = null;
      if (IS_WIN && child.pid) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
          // Process already exited or terminated
        });
      } else {
        child.kill('SIGTERM');
      }
      this._saveHistory();
      this._emitUpdate(job);
    }

    return this._publicJob(job);
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'downloading' || job.status === 'postprocessing' || job.status === 'queued') {
      return this._publicJob(job);
    }

    job.status = 'queued';
    job.percent = 0;
    job.downloadedBytes = 0;
    job.totalBytes = null;
    job.speedBytes = null;
    job.etaSeconds = null;
    job.error = null;
    job.completedAt = null;
    this._saveHistory();
    this._emitUpdate(job);
    this._pumpQueue();

    return this._publicJob(job);
  }

  remove(id, { deleteFile = false } = {}) {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (this.activeProcesses.has(id)) {
      this.cancel(id);
    }

    if (deleteFile && job.filePath && isPathInside(this.downloadsDir, job.filePath) && fs.existsSync(job.filePath)) {
      try {
        fs.unlinkSync(job.filePath);
      } catch {
        // Ignore file unlink failure if locked
      }
    }

    this.jobs.delete(id);
    this._saveHistory();
    this.emit('remove', id);
    return true;
  }

  clearCompleted() {
    const removedIds = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === 'completed' || job.status === 'error' || job.status === 'canceled') {
        this.jobs.delete(id);
        removedIds.push(id);
      }
    }
    if (removedIds.length > 0) {
      this._saveHistory();
      for (const id of removedIds) {
        this.emit('remove', id);
      }
    }
    return removedIds.length;
  }

  getSafeFilePath(id) {
    const job = this.jobs.get(id);
    if (!job || !job.filePath) return null;
    if (!isPathInside(this.downloadsDir, job.filePath)) return null;
    if (!fs.existsSync(job.filePath)) return null;
    return job.filePath;
  }
}

module.exports = { DownloadManager };
