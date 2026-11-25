const state = {
  mode: 'single',
  inspected: null,
  jobs: new Map(),
};

const els = {
  engineBadges: document.getElementById('engineBadges'),
  openFolderBtn: document.getElementById('openFolderBtn'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  singleMode: document.getElementById('singleMode'),
  batchMode: document.getElementById('batchMode'),
  inspectForm: document.getElementById('inspectForm'),
  urlInput: document.getElementById('urlInput'),
  pasteBtn: document.getElementById('pasteBtn'),
  inspectBtn: document.getElementById('inspectBtn'),
  quickDownloadBtn: document.getElementById('quickDownloadBtn'),
  playlistToggle: document.getElementById('playlistToggle'),
  batchTextarea: document.getElementById('batchTextarea'),
  batchPresetSelect: document.getElementById('batchPresetSelect'),
  batchQueueBtn: document.getElementById('batchQueueBtn'),
  feedbackBanner: document.getElementById('feedbackBanner'),
  previewCard: document.getElementById('previewCard'),
  previewThumb: document.getElementById('previewThumb'),
  previewDuration: document.getElementById('previewDuration'),
  previewSource: document.getElementById('previewSource'),
  previewUploader: document.getElementById('previewUploader'),
  previewPlaylistTag: document.getElementById('previewPlaylistTag'),
  previewTitle: document.getElementById('previewTitle'),
  presetSelect: document.getElementById('presetSelect'),
  advancedFormatGroup: document.getElementById('advancedFormatGroup'),
  exactFormatSelect: document.getElementById('exactFormatSelect'),
  startDownloadBtn: document.getElementById('startDownloadBtn'),
  playlistPreview: document.getElementById('playlistPreview'),
  playlistCountLabel: document.getElementById('playlistCountLabel'),
  playlistItems: document.getElementById('playlistItems'),
  queueCountBadge: document.getElementById('queueCountBadge'),
  clearCompletedBtn: document.getElementById('clearCompletedBtn'),
  emptyQueue: document.getElementById('emptyQueue'),
  downloadsList: document.getElementById('downloadsList'),
  downloadsDirText: document.getElementById('downloadsDirText'),
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** exp;
  return `${val.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}

function showBanner(message, type = 'error') {
  els.feedbackBanner.textContent = message;
  els.feedbackBanner.className = `banner ${type}`;
  els.feedbackBanner.classList.remove('hidden');
}

function hideBanner() {
  els.feedbackBanner.classList.add('hidden');
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function renderEngineBadges(engine, downloadsDir) {
  els.engineBadges.textContent = '';
  const items = [
    {
      label: engine?.ytdlpReady ? `yt-dlp ${engine.ytdlpVersion || 'ready'}` : 'yt-dlp missing',
      cls: engine?.ytdlpReady ? 'badge-ok' : 'badge-danger',
    },
    {
      label: engine?.ffmpegReady ? 'ffmpeg ready' : 'ffmpeg missing',
      cls: engine?.ffmpegReady ? 'badge-ok' : 'badge-warn',
    },
  ];
  for (const item of items) {
    const span = document.createElement('span');
    span.className = `badge ${item.cls}`;
    span.textContent = item.label;
    els.engineBadges.appendChild(span);
  }
  if (downloadsDir) {
    els.downloadsDirText.textContent = downloadsDir;
  }
}

function fallbackThumbnailSvg() {
  return 'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#0f172a"/><polygon points="68,30 102,45 68,60" fill="#475569"/></svg>'
    );
}

function renderPreview(meta) {
  state.inspected = meta;
  els.previewCard.classList.remove('hidden');
  els.previewThumb.src = meta.thumbnail || fallbackThumbnailSvg();
  els.previewThumb.onerror = () => {
    els.previewThumb.src = fallbackThumbnailSvg();
  };
  els.previewDuration.textContent = meta.isPlaylist ? `${meta.entryCount} items` : (meta.durationFormatted || '--:--');
  els.previewSource.textContent = meta.extractor || 'Web';
  els.previewUploader.textContent = meta.uploader ? `by ${meta.uploader}` : '';
  els.previewTitle.textContent = meta.title || meta.webpageUrl;
  els.previewPlaylistTag.classList.toggle('hidden', !meta.isPlaylist);

  // Populate exact formats dropdown
  els.exactFormatSelect.textContent = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = 'Use selected preset';
  els.exactFormatSelect.appendChild(defaultOpt);

  if (!meta.isPlaylist && Array.isArray(meta.formats) && meta.formats.length > 0) {
    els.advancedFormatGroup.classList.remove('hidden');
    for (const fmt of meta.formats) {
      const opt = document.createElement('option');
      opt.value = fmt.formatId;
      opt.textContent = fmt.label;
      els.exactFormatSelect.appendChild(opt);
    }
  } else {
    els.advancedFormatGroup.classList.add('hidden');
  }

  // Playlist entries
  els.playlistItems.textContent = '';
  if (meta.isPlaylist && Array.isArray(meta.entries) && meta.entries.length > 0) {
    els.playlistPreview.classList.remove('hidden');
    els.playlistCountLabel.textContent = `Playlist (${meta.entryCount} items)`;
    for (const entry of meta.entries) {
      const li = document.createElement('li');
      li.className = 'playlist-item';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'playlist-item-title';
      titleSpan.textContent = `${entry.index}. ${entry.title}${entry.durationFormatted && entry.durationFormatted !== '—' ? ` (${entry.durationFormatted})` : ''}`;

      li.appendChild(titleSpan);

      if (entry.url) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary btn-sm';
        btn.textContent = 'Download';
        btn.addEventListener('click', () => {
          enqueueDownload({
            url: entry.url,
            title: entry.title,
            extractor: meta.extractor,
            preset: els.presetSelect.value,
            allowPlaylist: false,
          });
        });
        li.appendChild(btn);
      }

      els.playlistItems.appendChild(li);
    }
  } else {
    els.playlistPreview.classList.add('hidden');
  }
}

function statusBadgeInfo(status) {
  switch (status) {
    case 'completed':
      return { text: 'Completed', cls: 'badge-ok' };
    case 'downloading':
      return { text: 'Downloading', cls: 'badge-info' };
    case 'postprocessing':
      return { text: 'Merging / Converting', cls: 'badge-info' };
    case 'queued':
      return { text: 'Queued', cls: 'badge-muted' };
    case 'canceled':
      return { text: 'Canceled', cls: 'badge-warn' };
    case 'error':
      return { text: 'Failed', cls: 'badge-danger' };
    default:
      return { text: status, cls: 'badge-muted' };
  }
}

function createActionButton(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderJobCard(job) {
  const card = document.createElement('article');
  card.className = 'job-card';
  card.dataset.jobId = job.id;

  const img = document.createElement('img');
  img.className = 'job-thumb';
  img.alt = '';
  img.src = job.thumbnail || fallbackThumbnailSvg();
  img.onerror = () => {
    img.src = fallbackThumbnailSvg();
  };
  card.appendChild(img);

  const main = document.createElement('div');
  main.className = 'job-main';

  const top = document.createElement('div');
  top.className = 'job-top';

  const title = document.createElement('div');
  title.className = 'job-title';
  title.textContent = job.fileName || job.title || job.url;
  title.title = job.fileName || job.title || job.url;

  const badgeInfo = statusBadgeInfo(job.status);
  const statusBadge = document.createElement('span');
  statusBadge.className = `badge ${badgeInfo.cls}`;
  statusBadge.textContent = badgeInfo.text;

  top.append(title, statusBadge);
  main.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'job-meta';

  const sourcePill = document.createElement('span');
  sourcePill.className = 'badge badge-source';
  sourcePill.textContent = job.extractor || 'Web';
  meta.appendChild(sourcePill);

  const presetPill = document.createElement('span');
  presetPill.className = 'badge badge-muted';
  presetPill.textContent = job.presetLabel || job.preset;
  meta.appendChild(presetPill);

  if (job.fileSize) {
    const sizeText = document.createElement('span');
    sizeText.textContent = formatBytes(job.fileSize);
    meta.appendChild(sizeText);
  }
  main.appendChild(meta);

  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = `progress-fill ${job.status === 'error' ? 'error' : ''}`;
  fill.style.width = `${Math.max(0, Math.min(100, job.percent || 0))}%`;
  track.appendChild(fill);
  main.appendChild(track);

  const bottom = document.createElement('div');
  bottom.className = 'job-bottom';

  const stats = document.createElement('div');
  if (job.status === 'error' || job.status === 'canceled') {
    stats.className = 'job-error';
    stats.textContent = job.error || 'Download stopped';
  } else if (job.status === 'completed') {
    stats.className = 'job-stats';
    stats.textContent = job.fileName ? `Saved: ${job.fileName}` : 'Saved to downloads folder';
  } else if (job.status === 'postprocessing') {
    stats.className = 'job-stats';
    stats.textContent = 'Merging video & audio with ffmpeg...';
  } else if (job.status === 'downloading') {
    stats.className = 'job-stats';
    const pct = `${(job.percent || 0).toFixed(1)}%`;
    const transferred = job.totalBytes
      ? `${formatBytes(job.downloadedBytes)} / ${formatBytes(job.totalBytes)}`
      : formatBytes(job.downloadedBytes);
    const speed = job.speedBytes ? `${formatBytes(job.speedBytes)}/s` : '--';
    const eta = job.etaSeconds !== null ? `ETA ${formatEta(job.etaSeconds)}` : '';
    stats.textContent = [pct, transferred, speed, eta].filter(Boolean).join(' • ');
  } else {
    stats.className = 'job-stats';
    stats.textContent = 'Waiting in queue...';
  }

  const actions = document.createElement('div');
  actions.className = 'job-actions';

  if (job.status === 'queued' || job.status === 'downloading') {
    actions.appendChild(
      createActionButton('Cancel', 'btn-danger-sm', () => apiJson(`/api/downloads/${job.id}/cancel`, { method: 'POST' }))
    );
  }

  if (job.status === 'completed' && job.hasFile) {
    const saveLink = document.createElement('a');
    saveLink.className = 'btn btn-accent btn-sm';
    saveLink.href = `/api/downloads/${job.id}/file`;
    saveLink.textContent = 'Save File';
    actions.appendChild(saveLink);

    actions.appendChild(
      createActionButton('Show in Folder', 'btn-secondary btn-sm', () =>
        apiJson(`/api/downloads/${job.id}/reveal`, { method: 'POST' }).catch((e) => showBanner(e.message))
      )
    );
  }

  if (job.status === 'error' || job.status === 'canceled') {
    actions.appendChild(
      createActionButton('Retry', 'btn-primary btn-sm', () =>
        apiJson(`/api/downloads/${job.id}/retry`, { method: 'POST' }).catch((e) => showBanner(e.message))
      )
    );
  }

  if (job.status !== 'downloading' && job.status !== 'postprocessing') {
    actions.appendChild(
      createActionButton('Remove', 'btn-ghost btn-sm', () =>
        apiJson(`/api/downloads/${job.id}`, { method: 'DELETE' }).catch((e) => showBanner(e.message))
      )
    );
  }

  bottom.append(stats, actions);
  main.appendChild(bottom);
  card.appendChild(main);
  return card;
}

function renderQueue() {
  const jobs = Array.from(state.jobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  els.queueCountBadge.textContent = String(jobs.length);
  els.emptyQueue.classList.toggle('hidden', jobs.length > 0);
  els.downloadsList.textContent = '';

  for (const job of jobs) {
    els.downloadsList.appendChild(renderJobCard(job));
  }
}

async function enqueueDownload(payload) {
  hideBanner();
  try {
    const data = await apiJson('/api/downloads', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (data.job) {
      state.jobs.set(data.job.id, data.job);
      renderQueue();
    } else if (Array.isArray(data.jobs)) {
      for (const job of data.jobs) state.jobs.set(job.id, job);
      renderQueue();
    }
  } catch (err) {
    showBanner(err.message, 'error');
  }
}

async function handleInspect(e) {
  e.preventDefault();
  hideBanner();
  const url = els.urlInput.value.trim();
  if (!url) return;

  els.inspectBtn.disabled = true;
  els.inspectBtn.textContent = 'Inspecting...';

  try {
    const meta = await apiJson('/api/inspect', {
      method: 'POST',
      body: JSON.stringify({
        url,
        allowPlaylist: els.playlistToggle.checked,
      }),
    });
    renderPreview(meta);
  } catch (err) {
    showBanner(err.message, 'error');
  } finally {
    els.inspectBtn.disabled = false;
    els.inspectBtn.textContent = 'Inspect';
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'snapshot') {
      state.jobs.clear();
      for (const job of msg.jobs || []) state.jobs.set(job.id, job);
      renderQueue();
      if (msg.engine) renderEngineBadges(msg.engine);
    } else if (msg.type === 'job_update' && msg.job) {
      state.jobs.set(msg.job.id, msg.job);
      renderQueue();
    } else if (msg.type === 'job_remove' && msg.id) {
      state.jobs.delete(msg.id);
      renderQueue();
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectWebSocket, 2000);
  });
}

async function init() {
  els.tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      els.tabBtns.forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      });
      els.singleMode.classList.toggle('hidden', state.mode !== 'single');
      els.batchMode.classList.toggle('hidden', state.mode !== 'batch');
      hideBanner();
    });
  });

  els.pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) els.urlInput.value = text.trim();
      els.urlInput.focus();
    } catch {
      showBanner('Clipboard permission denied. Paste manually with Ctrl+V.', 'info');
    }
  });

  els.inspectForm.addEventListener('submit', handleInspect);

  els.quickDownloadBtn.addEventListener('click', () => {
    const url = els.urlInput.value.trim();
    if (!url) {
      showBanner('Enter a URL first.', 'error');
      return;
    }
    enqueueDownload({
      url,
      preset: 'best',
      allowPlaylist: els.playlistToggle.checked,
    });
  });

  els.startDownloadBtn.addEventListener('click', () => {
    if (!state.inspected) return;
    enqueueDownload({
      url: state.inspected.webpageUrl || els.urlInput.value.trim(),
      title: state.inspected.title,
      thumbnail: state.inspected.thumbnail,
      extractor: state.inspected.extractor,
      preset: els.presetSelect.value,
      formatId: els.exactFormatSelect.value || null,
      allowPlaylist: Boolean(state.inspected.isPlaylist),
    });
  });

  els.batchQueueBtn.addEventListener('click', async () => {
    const urls = els.batchTextarea.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      showBanner('Paste at least one URL in the batch box.', 'error');
      return;
    }

    await enqueueDownload({
      urls,
      preset: els.batchPresetSelect.value,
      allowPlaylist: false,
    });
    els.batchTextarea.value = '';
    showBanner(`Added ${urls.length} item(s) to the download queue.`, 'info');
  });

  els.clearCompletedBtn.addEventListener('click', () => {
    apiJson('/api/downloads/clear', { method: 'POST' }).catch((e) => showBanner(e.message));
  });

  els.openFolderBtn.addEventListener('click', () => {
    apiJson('/api/open-folder', { method: 'POST' }).catch((e) => showBanner(e.message));
  });

  try {
    const health = await apiJson('/api/health');
    renderEngineBadges(health.engine, health.downloadsDir);
  } catch (err) {
    showBanner(err.message, 'error');
  }

  connectWebSocket();
}

init();
