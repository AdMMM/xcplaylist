// Main Application Controller
const App = (() => {
  // State
  let currentSection = 'live';
  let currentCategoryId = null;
  let allItems = [];
  let favorites = {};
  let history = [];
  let continueWatching = {};
  let reminders = {};
  let searchTimeout = null;
  let currentPlayingItem = null;

  // Channel zapping
  let liveChannelList = [];
  let liveChannelIndex = -1;

  // Format cycling
  let currentFormatIndex = 0;
  let formatTimer = null;

  // Format memory — remembers which streams need transcoding due to unsupported audio
  let formatMemory = {};
  // Audio health check
  let audioCheckInterval = null;
  let audioAutoSwitched = false;
  // FFmpeg transcode availability
  let transcodeAvailable = false;

  // Timers
  let qualityInterval = null;
  let positionInterval = null;
  let zapTimer = null;
  let reminderCheckInterval = null;
  let toastTimer = null;
  let idleTimer = null;

  const MAX_HISTORY = 50;
  const IDLE_TIMEOUT = 10000;

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const loginScreen = $('login-screen');
  const appScreen = $('app-screen');
  const loginForm = $('login-form');
  const loginError = $('login-error');
  const loginBtn = $('login-btn');
  const sidebar = $('sidebar');
  const categoryList = $('category-list');
  const channelGrid = $('channel-grid');
  const loading = $('loading');
  const searchInput = $('search-input');
  const playerOverlay = $('player-overlay');
  const playerTitle = $('player-title');
  const playerFav = $('player-fav');
  const epgPanel = $('epg-panel');
  const epgList = $('epg-list');
  const seriesOverlay = $('series-overlay');
  const seriesTitle = $('series-title');
  const seriesInfo = $('series-info');
  const seasonTabs = $('season-tabs');
  const episodeListEl = $('episode-list');
  const continueWatchingEl = $('continue-watching');
  const continueListEl = $('continue-list');
  const qualityIndicator = $('quality-indicator');
  const qualityDot = $('quality-dot');
  const qualityText = $('quality-text');
  const channelZapEl = $('channel-zap');
  const zapChannelEl = $('zap-channel');
  const reminderToast = $('reminder-toast');
  const toastTextEl = $('toast-text');

  // ===== Init =====
  function init() {
    // Detect platform for CSS overrides (macOS traffic light padding, etc.)
    if (navigator.platform && navigator.platform.startsWith('Win')) {
      document.body.classList.add('platform-win');
    }

    Player.init($('video-player'));
    loadFavorites();
    loadHistory();
    loadContinueWatching();
    loadReminders();
    loadFormatMemory();
    bindEvents();
    tryAutoLogin();
    // Check if server has FFmpeg for audio transcoding
    XC.checkTranscode().then(ok => { transcodeAvailable = ok; });

    // Check reminders every 30s
    reminderCheckInterval = setInterval(checkReminders, 30000);

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function bindEvents() {
    loginForm.addEventListener('submit', handleLogin);
    $('logout-btn').addEventListener('click', handleLogout);
    $('sidebar-toggle').addEventListener('click', () => sidebar.classList.toggle('collapsed'));

    // Navigation
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        switchSection(btn.dataset.section);
      });
    });

    // Search
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(filterItems, 200);
    });

    // Player controls
    $('player-close').addEventListener('click', closePlayer);
    $('ctrl-play').addEventListener('click', () => { Player.togglePlay(); updatePlayBtn(); });
    $('ctrl-mute').addEventListener('click', () => { Player.toggleMute(); updateMuteBtn(); });
    $('ctrl-fullscreen').addEventListener('click', Player.toggleFullscreen);
    $('ctrl-pip').addEventListener('click', Player.togglePiP);
    $('volume-slider').addEventListener('input', (e) => Player.setVolume(parseFloat(e.target.value)));
    $('player-fav').addEventListener('click', toggleCurrentFavorite);
    $('ctrl-format').addEventListener('click', cycleFormat);

    // Video events
    const video = $('video-player');
    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('play', updatePlayBtn);
    video.addEventListener('pause', updatePlayBtn);

    // PiP events
    video.addEventListener('enterpictureinpicture', () => {
      playerOverlay.classList.add('hidden');
      // Set document title so PiP window shows channel name instead of URL
      const name = playerTitle.textContent;
      if (name) document.title = name;
    });
    video.addEventListener('leavepictureinpicture', () => {
      document.title = 'XCPlaylist - IPTV Player';
      if (currentPlayingItem) {
        playerOverlay.classList.remove('hidden');
      }
    });

    // Progress bar seeking
    $('progress-bar').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      Player.seek(pct * Player.duration());
    });

    // Player error
    Player.onError((msg) => {
      playerTitle.textContent += ` - ${msg}`;
    });

    // Series close
    $('series-close').addEventListener('click', () => seriesOverlay.classList.add('hidden'));

    // Reminder toast
    $('toast-close').addEventListener('click', hideToast);

    // Idle detection for player (hide controls + cursor)
    playerOverlay.addEventListener('mousemove', resetIdle);
    playerOverlay.addEventListener('mousedown', resetIdle);

    // Single keydown handler for both idle reset and shortcuts
    document.addEventListener('keydown', handleKeydown);
  }

  // ===== Idle Detection =====
  function resetIdle() {
    if (playerOverlay.classList.contains('hidden')) return;
    playerOverlay.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!playerOverlay.classList.contains('hidden')) {
        playerOverlay.classList.add('idle');
      }
    }, IDLE_TIMEOUT);
  }

  function stopIdleTimer() {
    clearTimeout(idleTimer);
    playerOverlay.classList.remove('idle');
  }

  function handleKeydown(e) {
    // Always reset idle on any keypress when player is open
    if (!playerOverlay.classList.contains('hidden')) {
      resetIdle();
    }

    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (playerOverlay.classList.contains('hidden')) return;

    switch (e.key) {
      case 'Escape':
        closePlayer();
        break;
      case ' ':
        e.preventDefault();
        Player.togglePlay();
        updatePlayBtn();
        break;
      case 'f':
        Player.toggleFullscreen();
        break;
      case 'm':
        Player.toggleMute();
        updateMuteBtn();
        break;
      case 'p':
        Player.togglePiP();
        break;
      case 'ArrowRight':
        if (!Player.isLive) { e.preventDefault(); Player.seek(Player.currentTime() + 10); }
        break;
      case 'ArrowLeft':
        if (!Player.isLive) { e.preventDefault(); Player.seek(Player.currentTime() - 10); }
        break;
      case 'ArrowUp':
        if (Player.isLive && liveChannelList.length > 1) { e.preventDefault(); zapChannel(-1); }
        break;
      case 'ArrowDown':
        if (Player.isLive && liveChannelList.length > 1) { e.preventDefault(); zapChannel(1); }
        break;
    }
  }

  // ===== Auth =====
  async function handleLogin(e) {
    e.preventDefault();
    loginError.classList.add('hidden');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Connecting...';

    const server = $('server-url').value.trim().replace(/\/+$/, '');
    const username = $('username').value.trim();
    const password = $('password').value.trim();

    try {
      XC.setCreds(server, username, password);
      const data = await XC.auth();

      if (data.user_info?.auth === 0) {
        throw new Error('Invalid credentials');
      }

      if ($('remember-me').checked) {
        localStorage.setItem('xc_creds', JSON.stringify({ server, username, password }));
      }

      showApp();
    } catch (err) {
      loginError.textContent = err.message || 'Connection failed';
      loginError.classList.remove('hidden');
      XC.clearCreds();
    }

    loginBtn.disabled = false;
    loginBtn.textContent = 'Connect';
  }

  async function tryAutoLogin() {
    const saved = localStorage.getItem('xc_creds');
    if (saved) {
      try {
        const { server, username, password } = JSON.parse(saved);
        // Pre-fill form as fallback
        $('server-url').value = server;
        $('username').value = username;
        $('password').value = password;

        // Attempt silent auto-login
        XC.setCreds(server, username, password);
        const data = await XC.auth();
        if (data.user_info?.auth === 0) throw new Error('Auth failed');
        showApp();
      } catch {
        // Auto-login failed — stay on login screen with pre-filled fields
        XC.clearCreds();
      }
    }
  }

  function handleLogout() {
    closePlayer();
    localStorage.removeItem('xc_creds');
    XC.clearCreds();
    appScreen.classList.remove('active');
    loginScreen.classList.add('active');
  }

  function showApp() {
    loginScreen.classList.remove('active');
    appScreen.classList.add('active');
    switchSection('live');
    EPG.load();
  }

  // ===== Sections =====
  async function switchSection(section) {
    currentSection = section;
    currentCategoryId = null;
    searchInput.value = '';
    channelGrid.innerHTML = '';
    categoryList.innerHTML = '';
    continueWatchingEl.classList.add('hidden');

    if (section === 'favorites') {
      sidebar.classList.add('collapsed');
      renderFavorites();
      return;
    }

    if (section === 'history') {
      sidebar.classList.add('collapsed');
      renderHistory();
      return;
    }

    sidebar.classList.remove('collapsed');
    showLoading(true);

    try {
      let categories;
      if (section === 'live') categories = await XC.liveCategories();
      else if (section === 'vod') categories = await XC.vodCategories();
      else if (section === 'series') categories = await XC.seriesCategories();

      renderCategories(categories || []);
      await loadItems();
    } catch (e) {
      channelGrid.innerHTML = `<div class="no-results">Failed to load: ${e.message}</div>`;
    }

    showLoading(false);

    // Show continue watching for VOD and Series
    if (section === 'vod' || section === 'series') {
      renderContinueWatching();
    }
  }

  function renderCategories(categories) {
    const allBtn = document.createElement('button');
    allBtn.className = 'cat-item active';
    allBtn.textContent = `All (${currentSection === 'live' ? 'Live' : currentSection === 'vod' ? 'Movies' : 'Series'})`;
    allBtn.addEventListener('click', () => selectCategory(null, allBtn));
    categoryList.appendChild(allBtn);

    categories.forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = 'cat-item';
      btn.textContent = cat.category_name;
      btn.addEventListener('click', () => selectCategory(cat.category_id, btn));
      categoryList.appendChild(btn);
    });
  }

  async function selectCategory(catId, btn) {
    currentCategoryId = catId;
    document.querySelectorAll('.cat-item').forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    searchInput.value = '';
    showLoading(true);
    await loadItems();
    showLoading(false);
  }

  async function loadItems() {
    try {
      if (currentSection === 'live') {
        allItems = await XC.liveStreams(currentCategoryId);
      } else if (currentSection === 'vod') {
        allItems = await XC.vodStreams(currentCategoryId);
      } else if (currentSection === 'series') {
        allItems = await XC.seriesStreams(currentCategoryId);
      }
      renderItems(allItems || []);
    } catch (e) {
      channelGrid.innerHTML = `<div class="no-results">Error loading content</div>`;
    }
  }

  // ===== Rendering =====
  function renderItems(items) {
    channelGrid.innerHTML = '';

    if (!items.length) {
      channelGrid.innerHTML = '<div class="no-results">No content found</div>';
      return;
    }

    const frag = document.createDocumentFragment();

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'card';

      const isPoster = currentSection === 'vod' || currentSection === 'series';
      const imgSrc = item.stream_icon || item.cover || '';
      const name = item.name || item.title || '';

      let sub = '';
      if (currentSection === 'live') {
        sub = item.category_name || '';
      } else if (currentSection === 'vod' || currentSection === 'series') {
        sub = item.rating ? `Rating: ${item.rating}` : '';
      }

      card.innerHTML = `
        ${imgSrc ? `<img class="card-img${isPoster ? ' poster' : ''}" src="${escHtml(imgSrc)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="card-img${isPoster ? ' poster' : ''}" style="display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-dim)">${escHtml(name.slice(0, 30))}</div>`}
        ${currentSection === 'live' ? '<span class="card-live">LIVE</span>' : ''}
        <div class="card-body">
          <div class="card-title" title="${escHtml(name)}">${escHtml(name)}</div>
          ${sub ? `<div class="card-sub">${escHtml(sub)}</div>` : ''}
        </div>
      `;

      const favKey = `${currentSection}:${item.stream_id || item.series_id}`;
      if (favorites[favKey]) {
        const favBtn = document.createElement('button');
        favBtn.className = 'card-fav';
        favBtn.innerHTML = '&#9733;';
        card.appendChild(favBtn);
      }

      card.addEventListener('click', () => handleItemClick(item));
      frag.appendChild(card);
    });

    channelGrid.appendChild(frag);
  }

  function filterItems() {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) {
      renderItems(allItems);
      return;
    }
    const filtered = allItems.filter((item) => {
      const name = (item.name || item.title || '').toLowerCase();
      return name.includes(q);
    });
    renderItems(filtered);
  }

  // ===== Item Click Handlers =====
  async function handleItemClick(item) {
    if (currentSection === 'live') {
      await playLive(item);
    } else if (currentSection === 'vod') {
      await playVod(item);
    } else if (currentSection === 'series') {
      await showSeries(item);
    } else if (currentSection === 'favorites') {
      const favData = item._favData;
      if (favData.type === 'live') await playLive(favData.item);
      else if (favData.type === 'vod') await playVod(favData.item);
      else if (favData.type === 'series') await showSeries(favData.item);
    } else if (currentSection === 'history') {
      const histData = item._histData;
      if (histData.type === 'live') await playLive(histData.item);
      else if (histData.type === 'vod') await playVod(histData.item);
      else if (histData.type === 'series') await showSeries(histData.item);
    }
  }

  async function playLive(item) {
    // Check if this stream previously needed transcode/HLS for audio
    const remembered = getRememberedFormat(String(item.stream_id));
    currentPlayingItem = { type: 'live', item };

    let url;
    currentFormatIndex = 0;

    if (remembered === 'transcode' && transcodeAvailable) {
      url = XC.transcodeUrl(item.stream_id, 'live');
      const cycle = getFormatCycle();
      const idx = cycle.indexOf('transcode');
      if (idx >= 0) currentFormatIndex = idx;
    } else if (remembered === 'm3u8') {
      const resp = await XC.streamUrl(item.stream_id, 'live', 'm3u8');
      url = resp.url;
      const cycle = getFormatCycle();
      const idx = cycle.indexOf('m3u8');
      if (idx >= 0) currentFormatIndex = idx;
    } else {
      const resp = await XC.streamUrl(item.stream_id, 'live');
      url = resp.url;
    }

    // Store channel list for zapping
    if (allItems.length > 0 && currentSection === 'live') {
      liveChannelList = [...allItems];
    }
    liveChannelIndex = liveChannelList.findIndex(i => i.stream_id === item.stream_id);

    openPlayer(item.name, url, true);
    loadEpgForStream(item);
    addToHistory('live', item);
  }

  async function playVod(item) {
    const remembered = getRememberedFormat(String(item.stream_id));
    const title = item.name || item.title;
    currentPlayingItem = { type: 'vod', item };

    let url;
    currentFormatIndex = 0;

    if (remembered === 'transcode' && transcodeAvailable) {
      url = XC.transcodeUrl(item.stream_id, 'vod');
      const cycle = getFormatCycle();
      const idx = cycle.indexOf('transcode');
      if (idx >= 0) currentFormatIndex = idx;
    } else if (remembered === 'm3u8') {
      const resp = await XC.streamUrl(item.stream_id, 'vod', 'm3u8');
      url = resp.url;
      const cycle = getFormatCycle();
      const idx = cycle.indexOf('m3u8');
      if (idx >= 0) currentFormatIndex = idx;
    } else {
      const container = item.container_extension || 'mp4';
      const resp = await XC.streamUrl(item.stream_id, 'vod', container);
      url = resp.url;
    }

    openPlayer(title, url, false);
    epgPanel.classList.add('hidden');
    addToHistory('vod', item);
    maybeResume(`vod:${item.stream_id}`);
  }

  async function playSeries(episode, seriesName) {
    const remembered = getRememberedFormat(String(episode.id));
    const title = `${seriesName} - ${episode.title || `Episode ${episode.episode_num}`}`;
    currentPlayingItem = { type: 'series', item: episode };

    let url;
    currentFormatIndex = 0;

    if (remembered === 'transcode' && transcodeAvailable) {
      url = XC.transcodeUrl(episode.id, 'series');
      const cycle = getFormatCycle();
      const idx = cycle.indexOf('transcode');
      if (idx >= 0) currentFormatIndex = idx;
    } else if (remembered === 'm3u8') {
      const resp = await XC.streamUrl(episode.id, 'series', 'm3u8');
      url = resp.url;
      const cycle = getFormatCycle();
      const idx = cycle.indexOf('m3u8');
      if (idx >= 0) currentFormatIndex = idx;
    } else {
      const container = episode.container_extension || 'mp4';
      const resp = await XC.streamUrl(episode.id, 'series', container);
      url = resp.url;
    }

    openPlayer(title, url, false);
    epgPanel.classList.add('hidden');
    addToHistory('series', episode, title);
    maybeResume(`series:${episode.id}`);
  }

  // Resume from continue watching position if available
  function maybeResume(cwKey) {
    const cw = continueWatching[cwKey];
    if (cw) {
      setTimeout(() => Player.seek(cw.position), 1500);
    }
  }

  // ===== Player =====
  function openPlayer(title, url, live) {
    playerTitle.textContent = title;
    playerOverlay.classList.remove('hidden');
    // Set Media Session metadata so PiP window shows channel name
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title });
    }
    updateFavBtn();
    // currentFormatIndex is set by playLive/playVod/playSeries before calling openPlayer
    $('ctrl-format').title = `Format: ${getFormatLabel(getFormatCycle()[currentFormatIndex] || 'ts')} (click to switch)`;
    $('format-overlay').classList.add('hidden');

    $('progress-bar').classList.toggle('hidden', live);
    $('time-display').textContent = '';

    Player.play(url, live);

    resetIdle();
    startQualityMonitor();
    startAudioHealthCheck();
    if (!live) startPositionTracking();
  }

  function closePlayer() {
    stopPositionTracking();
    stopQualityMonitor();
    stopAudioHealthCheck();
    stopIdleTimer();
    clearTimeout(zapTimer);
    clearTimeout(formatTimer);

    // Exit PiP if active
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }

    Player.destroy();
    playerOverlay.classList.add('hidden');
    epgPanel.classList.add('hidden');
    channelZapEl.classList.add('hidden');
    currentPlayingItem = null;
  }

  function updatePlayBtn() {
    $('ctrl-play').innerHTML = Player.isPlaying() ? '&#9646;&#9646;' : '&#9654;';
  }

  function updateMuteBtn() {
    $('ctrl-mute').innerHTML = Player.isMuted() ? '&#128263;' : '&#128264;';
  }

  function updateProgress() {
    if (Player.isLive) return;
    const dur = Player.duration();
    const cur = Player.currentTime();
    if (!dur || isNaN(dur)) return;
    const pct = (cur / dur) * 100;
    $('progress-fill').style.width = pct + '%';
    $('time-display').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  }

  function fmtTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // ===== Channel Zapping =====
  function zapChannel(direction) {
    if (liveChannelList.length < 2) return;

    liveChannelIndex = (liveChannelIndex + direction + liveChannelList.length) % liveChannelList.length;
    const item = liveChannelList[liveChannelIndex];

    // Show zap overlay
    zapChannelEl.textContent = item.name || '';
    channelZapEl.classList.remove('hidden');
    clearTimeout(zapTimer);
    zapTimer = setTimeout(() => channelZapEl.classList.add('hidden'), 3000);

    playLive(item);
  }

  // ===== Format Cycling =====
  function getFormatCycle() {
    if (!currentPlayingItem) return ['ts'];
    const type = currentPlayingItem.type;
    if (type === 'live') {
      const cycle = ['ts', 'm3u8'];
      if (transcodeAvailable) cycle.push('transcode');
      return cycle;
    }
    // VOD/series: try original container, then mp4, then m3u8, then transcode
    const orig = currentPlayingItem.item.container_extension || 'mp4';
    const formats = [orig];
    if (orig !== 'mp4') formats.push('mp4');
    formats.push('m3u8');
    if (transcodeAvailable) formats.push('transcode');
    return [...new Set(formats)]; // deduplicate
  }

  function getFormatLabel(fmt) {
    const labels = { ts: 'MPEG-TS', m3u8: 'HLS', mp4: 'MP4', mkv: 'MKV', avi: 'AVI', transcode: 'AAC Fix' };
    return labels[fmt] || fmt.toUpperCase();
  }

  async function cycleFormat() {
    if (!currentPlayingItem) return;
    const cycle = getFormatCycle();
    if (cycle.length < 2) return; // nothing to cycle to

    currentFormatIndex = (currentFormatIndex + 1) % cycle.length;
    const fmt = cycle[currentFormatIndex];
    const item = currentPlayingItem.item;
    const type = currentPlayingItem.type;
    const streamId = String(item.stream_id || item.id);

    // Show format overlay
    const formatOverlay = $('format-overlay');
    const formatText = $('format-text');
    formatText.textContent = `Switching to ${getFormatLabel(fmt)}...`;
    formatOverlay.classList.remove('hidden');
    clearTimeout(formatTimer);
    formatTimer = setTimeout(() => formatOverlay.classList.add('hidden'), 3000);

    // Update button tooltip
    $('ctrl-format').title = `Format: ${getFormatLabel(fmt)} (click to switch)`;

    // Remember format choice (clear memory if returning to default)
    if (currentFormatIndex === 0) {
      delete formatMemory[streamId];
      saveFormatMemory();
    } else {
      rememberFormat(streamId, fmt);
    }

    // Stop audio auto-switch since user is manually cycling
    audioAutoSwitched = true;

    try {
      let url;
      if (fmt === 'transcode') {
        url = XC.transcodeUrl(streamId, type);
        if (!url) throw new Error('Cannot build transcode URL');
      } else {
        const resp = await XC.streamUrl(streamId, type, fmt);
        url = resp.url;
      }
      const live = type === 'live';
      Player.play(url, live);
      resetIdle();
      // Restart audio check for the new format
      startAudioHealthCheck();
    } catch (e) {
      formatText.textContent = `Failed to switch format`;
    }
  }

  // ===== Format Memory =====
  // Remembers streams that needed HLS due to unsupported audio (AC3/EAC3/DTS/Atmos)
  function loadFormatMemory() {
    try { formatMemory = JSON.parse(localStorage.getItem('xc_format_memory') || '{}'); }
    catch { formatMemory = {}; }
    // Prune entries older than 30 days
    const cutoff = Date.now() - 30 * 86400000;
    let changed = false;
    for (const key of Object.keys(formatMemory)) {
      if (formatMemory[key].ts < cutoff) { delete formatMemory[key]; changed = true; }
    }
    if (changed) saveFormatMemory();
  }

  function saveFormatMemory() {
    localStorage.setItem('xc_format_memory', JSON.stringify(formatMemory));
  }

  function rememberFormat(streamId, format) {
    formatMemory[streamId] = { fmt: format, ts: Date.now() };
    saveFormatMemory();
  }

  function getRememberedFormat(streamId) {
    const entry = formatMemory[streamId];
    return entry ? entry.fmt : null;
  }

  // ===== Audio Auto-Detection =====
  // Monitors audio decode health after playback starts.
  // If video plays but no audio bytes are decoded (AC3/EAC3/DTS/Atmos),
  // automatically switches to HLS format which the server transcodes to AAC.
  function startAudioHealthCheck() {
    stopAudioHealthCheck();
    audioAutoSwitched = false;
    // Wait 3.5s for decoder to stabilise, then check every 2s
    audioCheckInterval = setTimeout(() => {
      audioCheckInterval = setInterval(checkAudioHealth, 2000);
      checkAudioHealth(); // immediate first check
    }, 3500);
  }

  function stopAudioHealthCheck() {
    clearTimeout(audioCheckInterval);
    clearInterval(audioCheckInterval);
    audioCheckInterval = null;
  }

  function checkAudioHealth() {
    if (!currentPlayingItem || audioAutoSwitched) return;

    const health = Player.getAudioHealth();
    if (health !== 'silent') return; // 'ok' or 'unknown' — no action needed

    // Audio is silent — the codec is likely unsupported (AC3/EAC3/DTS/Atmos)
    const cycle = getFormatCycle();
    const currentFmt = cycle[currentFormatIndex];

    // Already on transcode — nothing more we can do
    if (currentFmt === 'transcode') return;

    const item = currentPlayingItem.item;
    const streamId = String(item.stream_id || item.id);
    const type = currentPlayingItem.type;

    // Strategy: prefer FFmpeg transcode (guaranteed fix) over HLS (might not help)
    const transcodeIndex = cycle.indexOf('transcode');
    const hlsIndex = cycle.indexOf('m3u8');

    // If already on HLS and it's still silent, jump to transcode
    if (currentFmt === 'm3u8' && transcodeIndex !== -1) {
      console.log('[app] HLS still silent — escalating to FFmpeg transcode');
      audioAutoSwitched = true;
      stopAudioHealthCheck();
      currentFormatIndex = transcodeIndex;
      rememberFormat(streamId, 'transcode');
      showFormatSwitch('Audio fix — transcoding via FFmpeg...', 'AAC Fix');

      const url = XC.transcodeUrl(streamId, type);
      if (url) {
        Player.play(url, type === 'live');
        resetIdle();
      }
      return;
    }

    // First attempt: try transcode directly if available (most reliable)
    if (transcodeAvailable && transcodeIndex !== -1) {
      console.log('[app] Silent audio detected — switching to FFmpeg transcode');
      audioAutoSwitched = true;
      stopAudioHealthCheck();
      currentFormatIndex = transcodeIndex;
      rememberFormat(streamId, 'transcode');
      showFormatSwitch('Unsupported audio — transcoding to AAC...', 'AAC Fix');

      const url = XC.transcodeUrl(streamId, type);
      if (url) {
        Player.play(url, type === 'live');
        resetIdle();
      }
      return;
    }

    // Fallback: try HLS (might work if server transcodes)
    if (hlsIndex !== -1 && currentFmt !== 'm3u8') {
      console.log('[app] Silent audio detected — trying HLS format');
      // Don't mark as fully auto-switched — if HLS also fails, we'll escalate
      currentFormatIndex = hlsIndex;
      showFormatSwitch('Unsupported audio — trying HLS...', 'HLS');

      XC.streamUrl(streamId, type, 'm3u8').then(({ url }) => {
        Player.play(url, type === 'live');
        resetIdle();
        // Reset audio check to re-evaluate after HLS loads
        Player.resetAudioCheck();
      }).catch(() => {
        $('format-text').textContent = 'Failed to switch format';
      });
      return;
    }

    // Nothing worked
    audioAutoSwitched = true;
    stopAudioHealthCheck();
  }

  function showFormatSwitch(message, label) {
    const formatOverlay = $('format-overlay');
    const formatText = $('format-text');
    formatText.textContent = message;
    formatOverlay.classList.remove('hidden');
    clearTimeout(formatTimer);
    formatTimer = setTimeout(() => formatOverlay.classList.add('hidden'), 4000);
    $('ctrl-format').title = `Format: ${label} (click to switch)`;
  }

  // ===== Quality Indicator =====
  function startQualityMonitor() {
    clearInterval(qualityInterval);
    qualityInterval = setInterval(updateQuality, 2000);
    setTimeout(updateQuality, 1000);
  }

  function stopQualityMonitor() {
    clearInterval(qualityInterval);
    qualityIndicator.classList.add('hidden');
  }

  function updateQuality() {
    const stats = Player.getQualityStats();
    if (!stats.resolution) {
      qualityIndicator.classList.add('hidden');
      return;
    }

    qualityIndicator.classList.remove('hidden');
    qualityText.textContent = stats.resolution;
    qualityDot.className = 'quality-' + stats.health;
  }

  // ===== Continue Watching =====
  function loadContinueWatching() {
    try { continueWatching = JSON.parse(localStorage.getItem('xc_continue') || '{}'); }
    catch { continueWatching = {}; }
  }

  function saveContinueWatching() {
    localStorage.setItem('xc_continue', JSON.stringify(continueWatching));
  }

  function startPositionTracking() {
    clearInterval(positionInterval);
    positionInterval = setInterval(saveCurrentPosition, 10000);
  }

  function stopPositionTracking() {
    clearInterval(positionInterval);
    saveCurrentPosition();
  }

  function saveCurrentPosition() {
    if (!currentPlayingItem || currentPlayingItem.type === 'live') return;
    const dur = Player.duration();
    const cur = Player.currentTime();
    if (!dur || isNaN(dur) || dur < 60) return;

    const item = currentPlayingItem.item;
    const key = `${currentPlayingItem.type}:${item.stream_id || item.id}`;

    // If >95% complete, remove from continue watching
    if (cur / dur > 0.95) {
      delete continueWatching[key];
    } else if (cur > 30) {
      continueWatching[key] = {
        type: currentPlayingItem.type,
        streamId: item.stream_id || item.id,
        title: playerTitle.textContent,
        position: cur,
        duration: dur,
        timestamp: Date.now(),
        // Store only essential fields for replay, not the full item
        name: item.name || item.title || '',
        cover: item.stream_icon || item.cover || '',
        container: item.container_extension || null,
        series_id: item.series_id || null,
        episode_num: item.episode_num || null,
      };
    }
    saveContinueWatching();
  }

  function renderContinueWatching() {
    const items = Object.values(continueWatching)
      .filter(cw => cw.type === currentSection)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10);

    if (!items.length) {
      continueWatchingEl.classList.add('hidden');
      return;
    }

    continueWatchingEl.classList.remove('hidden');
    continueListEl.innerHTML = '';

    items.forEach(cw => {
      const card = document.createElement('div');
      card.className = 'cw-card';
      const pct = Math.round((cw.position / cw.duration) * 100);
      const imgSrc = cw.cover || '';

      card.innerHTML = `
        ${imgSrc ? `<img class="cw-img" src="${escHtml(imgSrc)}" alt="" onerror="this.style.display='none'">` : `<div class="cw-img cw-placeholder">${escHtml((cw.title || '').slice(0, 20))}</div>`}
        <div class="cw-info">
          <div class="cw-title">${escHtml(cw.title)}</div>
          <div class="cw-time">${fmtTime(cw.position)} / ${fmtTime(cw.duration)}</div>
        </div>
        <div class="cw-progress"><div class="cw-progress-fill" style="width:${pct}%"></div></div>
      `;

      card.addEventListener('click', () => resumePlayback(cw));
      continueListEl.appendChild(card);
    });
  }

  async function resumePlayback(cw) {
    if (cw.type === 'vod') {
      // Rebuild a minimal item object for playVod
      const item = { stream_id: cw.streamId, name: cw.name, container_extension: cw.container, stream_icon: cw.cover };
      await playVod(item);
    } else if (cw.type === 'series') {
      const container = cw.container || 'mp4';
      const { url } = await XC.streamUrl(cw.streamId, 'series', container);
      currentPlayingItem = { type: 'series', item: { id: cw.streamId, container_extension: cw.container } };
      openPlayer(cw.title, url, false);
      epgPanel.classList.add('hidden');
      setTimeout(() => Player.seek(cw.position), 1500);
    }
  }

  // ===== History =====
  function loadHistory() {
    try { history = JSON.parse(localStorage.getItem('xc_history') || '[]'); }
    catch { history = []; }
  }

  function saveHistory() {
    localStorage.setItem('xc_history', JSON.stringify(history));
  }

  function addToHistory(type, item, titleOverride) {
    const streamId = item.stream_id || item.series_id || item.id;
    const entry = {
      type,
      streamId,
      title: titleOverride || item.name || item.title || '',
      timestamp: Date.now(),
      // Store only essential fields for replay
      name: item.name || item.title || '',
      cover: item.stream_icon || item.cover || '',
      container: item.container_extension || null,
      series_id: item.series_id || null,
    };

    // Remove duplicate
    history = history.filter(h => !(h.type === type && h.streamId === streamId));
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
    saveHistory();
  }

  function renderHistory() {
    if (!history.length) {
      channelGrid.innerHTML = '<div class="no-results">No watch history yet</div>';
      return;
    }

    channelGrid.innerHTML = '';
    const frag = document.createDocumentFragment();
    let lastDateLabel = '';

    history.forEach(entry => {
      const dateLabel = getDateLabel(entry.timestamp);

      if (dateLabel !== lastDateLabel) {
        lastDateLabel = dateLabel;
        const header = document.createElement('div');
        header.className = 'history-date-header';
        header.textContent = dateLabel;
        frag.appendChild(header);
      }

      const div = document.createElement('div');
      div.className = 'history-item';

      const typeLabel = entry.type === 'live' ? 'Live' : entry.type === 'vod' ? 'Movie' : 'Series';
      const timeStr = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      div.innerHTML = `
        <span class="history-type history-type-${entry.type}">${typeLabel}</span>
        <span class="history-title">${escHtml(entry.title)}</span>
        <span class="history-time">${timeStr}</span>
      `;

      div.addEventListener('click', () => playFromHistory(entry));
      frag.appendChild(div);
    });

    channelGrid.appendChild(frag);
  }

  async function playFromHistory(entry) {
    // Rebuild minimal item from stored fields
    const item = {
      stream_id: entry.streamId,
      series_id: entry.series_id,
      name: entry.name,
      title: entry.name,
      stream_icon: entry.cover,
      cover: entry.cover,
      container_extension: entry.container,
    };

    if (entry.type === 'live') await playLive(item);
    else if (entry.type === 'vod') await playVod(item);
    else if (entry.type === 'series') await showSeries(item);
  }

  function getDateLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today - 86400000);
    const itemDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    if (itemDate.getTime() === today.getTime()) return 'Today';
    if (itemDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // ===== EPG =====
  async function loadEpgForStream(item) {
    epgPanel.classList.remove('hidden');
    epgList.innerHTML = '<div class="spinner"></div>';

    const listings = await EPG.getShortEpg(item.stream_id);

    if (!listings.length) {
      epgList.innerHTML = '<div style="color:var(--text-dim);font-size:13px">No programme info available</div>';
      return;
    }

    epgList.innerHTML = '';
    const now = new Date();

    listings.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'epg-item';

      const isFuture = p.start > now;
      const hasReminder = isFuture && isReminderSet(item.stream_id, p);

      let reminderHtml = '';
      if (isFuture) {
        reminderHtml = `<button class="epg-remind${hasReminder ? ' active' : ''}">${hasReminder ? 'Set' : 'Remind'}</button>`;
      }

      div.innerHTML = `
        <span class="epg-time${p.isNow ? ' epg-now' : ''}">${EPG.formatTime(p.start)} - ${EPG.formatTime(p.end)}</span>
        <span class="epg-title${p.isNow ? ' epg-now' : ''}">${escHtml(p.title)}</span>
        ${reminderHtml}
      `;

      if (p.desc) div.title = p.desc;

      if (isFuture) {
        const btn = div.querySelector('.epg-remind');
        if (btn) {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            setReminder(p, item.stream_id, item.name, item);
            loadEpgForStream(item);
          });
        }
      }

      epgList.appendChild(div);
    });
  }

  // ===== EPG Reminders =====
  function loadReminders() {
    try { reminders = JSON.parse(localStorage.getItem('xc_reminders') || '{}'); }
    catch { reminders = {}; }
    // Clean expired
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(reminders)) {
      if (reminders[key].startTime < now - 120000) {
        delete reminders[key];
        changed = true;
      }
    }
    if (changed) saveReminders();
  }

  function saveReminders() {
    localStorage.setItem('xc_reminders', JSON.stringify(reminders));
  }

  function setReminder(programme, streamId, channelName, item) {
    const key = `${streamId}:${programme.start.getTime()}`;
    if (reminders[key]) {
      delete reminders[key];
    } else {
      reminders[key] = {
        streamId,
        channelName,
        programmeTitle: programme.title,
        startTime: programme.start.getTime(),
        // Store only essential fields for the reminder item
        itemName: item.name,
        itemStreamId: item.stream_id,
      };
    }
    saveReminders();
  }

  function isReminderSet(streamId, programme) {
    return !!reminders[`${streamId}:${programme.start.getTime()}`];
  }

  function checkReminders() {
    const now = Date.now();
    const margin = 60000;
    let changed = false;

    for (const [key, reminder] of Object.entries(reminders)) {
      if (now >= reminder.startTime - margin && now <= reminder.startTime + margin * 2) {
        fireReminder(reminder);
        delete reminders[key];
        changed = true;
      } else if (now > reminder.startTime + margin * 2) {
        delete reminders[key];
        changed = true;
      }
    }

    if (changed) saveReminders();
  }

  function fireReminder(reminder) {
    showToast(`${reminder.programmeTitle} is starting now on ${reminder.channelName}`, reminder);

    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('Programme Starting', {
        body: `${reminder.programmeTitle}\n${reminder.channelName}`,
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        playLive({ stream_id: reminder.itemStreamId, name: reminder.itemName || reminder.channelName });
      };
    }
  }

  function showToast(text, reminder) {
    toastTextEl.textContent = text;
    reminderToast.classList.remove('hidden');

    const watchBtn = $('toast-watch');
    watchBtn.onclick = () => {
      hideToast();
      playLive({ stream_id: reminder.itemStreamId, name: reminder.itemName || reminder.channelName });
    };

    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 15000);
  }

  function hideToast() {
    reminderToast.classList.add('hidden');
    clearTimeout(toastTimer);
  }

  // ===== Series =====
  async function showSeries(item) {
    seriesOverlay.classList.remove('hidden');
    seriesTitle.textContent = item.name || item.title || 'Series';
    seriesInfo.innerHTML = '<div class="spinner"></div>';
    seasonTabs.innerHTML = '';
    episodeListEl.innerHTML = '';

    try {
      const data = await XC.seriesInfo(item.series_id);
      const info = data.info || {};
      const episodes = data.episodes || {};

      seriesInfo.innerHTML = `
        ${info.cover ? `<img src="${escHtml(info.cover)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="info-text">
          <h2>${escHtml(info.name || item.name || '')}</h2>
          ${info.genre ? `<p><strong>Genre:</strong> ${escHtml(info.genre)}</p>` : ''}
          ${info.rating ? `<p><strong>Rating:</strong> ${info.rating}</p>` : ''}
          ${info.plot ? `<p>${escHtml(info.plot)}</p>` : ''}
          ${info.cast ? `<p><strong>Cast:</strong> ${escHtml(info.cast)}</p>` : ''}
        </div>
      `;

      const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));
      if (!seasons.length) {
        episodeListEl.innerHTML = '<div class="no-results">No episodes available</div>';
        return;
      }

      seasons.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.className = 'season-tab' + (i === 0 ? ' active' : '');
        btn.textContent = `Season ${s}`;
        btn.addEventListener('click', () => {
          document.querySelectorAll('.season-tab').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          renderEpisodes(episodes[s], info.name || item.name);
        });
        seasonTabs.appendChild(btn);
      });

      renderEpisodes(episodes[seasons[0]], info.name || item.name);
    } catch (e) {
      seriesInfo.innerHTML = `<div class="no-results">Failed to load series info</div>`;
    }
  }

  function renderEpisodes(episodes, seriesName) {
    episodeListEl.innerHTML = '';
    if (!episodes || !episodes.length) {
      episodeListEl.innerHTML = '<div class="no-results">No episodes</div>';
      return;
    }

    episodes.forEach((ep) => {
      const div = document.createElement('div');
      div.className = 'episode-item';

      const cwKey = `series:${ep.id}`;
      const cwData = continueWatching[cwKey];
      let progressHtml = '';
      if (cwData) {
        const pct = Math.round((cwData.position / cwData.duration) * 100);
        progressHtml = `<div class="ep-progress"><div class="ep-progress-fill" style="width:${pct}%"></div></div>`;
      }

      div.innerHTML = `
        <span class="ep-num">${ep.episode_num || '?'}</span>
        <span class="ep-title">${escHtml(ep.title || `Episode ${ep.episode_num}`)}</span>
        ${ep.info?.duration ? `<span class="ep-duration">${ep.info.duration}</span>` : ''}
        ${progressHtml}
      `;
      div.addEventListener('click', () => {
        seriesOverlay.classList.add('hidden');
        playSeries(ep, seriesName);
      });
      episodeListEl.appendChild(div);
    });
  }

  // ===== Favorites =====
  function loadFavorites() {
    try {
      favorites = JSON.parse(localStorage.getItem('xc_favorites') || '{}');
    } catch { favorites = {}; }
  }

  function saveFavorites() {
    localStorage.setItem('xc_favorites', JSON.stringify(favorites));
  }

  function toggleFavorite(type, item) {
    const key = `${type}:${item.stream_id || item.series_id}`;
    if (favorites[key]) {
      delete favorites[key];
    } else {
      favorites[key] = { type, item };
    }
    saveFavorites();
  }

  function isFavorite(type, item) {
    const key = `${type}:${item.stream_id || item.series_id}`;
    return !!favorites[key];
  }

  function toggleCurrentFavorite() {
    if (!currentPlayingItem) return;
    toggleFavorite(currentPlayingItem.type, currentPlayingItem.item);
    updateFavBtn();
  }

  function updateFavBtn() {
    if (!currentPlayingItem) return;
    const fav = isFavorite(currentPlayingItem.type, currentPlayingItem.item);
    playerFav.innerHTML = fav ? '&#9733;' : '&#9734;';
    playerFav.style.color = fav ? 'gold' : '';
  }

  function renderFavorites() {
    const keys = Object.keys(favorites);
    if (!keys.length) {
      channelGrid.innerHTML = '<div class="no-results">No favorites yet. Click the star while playing to add favorites.</div>';
      return;
    }

    allItems = keys.map((key) => {
      const fav = favorites[key];
      return { ...fav.item, _favData: fav };
    });

    renderItems(allItems);
  }

  // ===== Helpers =====
  function showLoading(show) {
    loading.classList.toggle('hidden', !show);
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Boot
  document.addEventListener('DOMContentLoaded', init);
})();
