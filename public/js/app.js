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
  let guideMode = false;
  let currentSort = 'default';

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
  let videoAutoSwitched = false;
  let videoFallbackOffered = false;
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
  const contentToolbar = $('content-toolbar');
  const sortSelect = $('sort-select');
  const cardMenu = $('card-menu');
  const detailDrawer = $('detail-drawer');
  const detailBody = $('detail-body');
  const contentEl = $('content');
  const loading = $('loading');
  const searchInput = $('search-input');
  const playerOverlay = $('player-overlay');
  const playerTitle = $('player-title');
  let basePlayerTitle = '';
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
  async function init() {
    // Detect platform for CSS overrides (macOS traffic light padding, etc.)
    if (navigator.platform && navigator.platform.startsWith('Win')) {
      document.body.classList.add('platform-win');
    }

    Player.init($('video-player'));
    Guide.init();
    loadFavorites();
    loadHistory();
    loadContinueWatching();
    loadReminders();
    loadFormatMemory();
    localStorage.removeItem('xc_empty_series'); // clear tiles wrongly hidden by the dropped removal feature
    // Logo fallback: on a broken provider logo, swap to the bundled local logo
    // (matched by channel name) if one exists, else hide so the plate stays clean.
    window.__logoFallback = (img) => {
      const local = img.getAttribute('data-local');
      if (local && !img.src.endsWith(local)) {
        img.removeAttribute('data-local');
        img.src = local;
      } else {
        img.style.display = 'none';
      }
    };
    await XC.loadLogoIndex(); // bundled channel-logo pack — ready before first render
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

    // Sort
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      filterItems();
    });

    // Right-click context menu dismissal
    document.addEventListener('click', hideCardMenu);
    document.addEventListener('scroll', hideCardMenu, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCardMenu(); closeDetail(); } });

    // Movie detail drawer — close on click outside (not on a tile, which opens it)
    $('detail-close').addEventListener('click', closeDetail);
    document.addEventListener('click', (e) => {
      if (detailDrawer.classList.contains('hidden')) return;
      if (e.target.closest('#detail-drawer') || e.target.closest('.card')) return;
      closeDetail();
    });

    // Player controls
    $('player-close').addEventListener('click', closePlayer);
    $('ctrl-play').addEventListener('click', () => { Player.togglePlay(); updatePlayBtn(); });
    $('ctrl-mute').addEventListener('click', () => { Player.toggleMute(); updateMuteBtn(); });
    $('ctrl-fullscreen').addEventListener('click', Player.toggleFullscreen);
    $('ctrl-pip').addEventListener('click', Player.togglePiP);
    $('ctrl-external').addEventListener('click', openCurrentExternal);
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

    // Player error — overwrite (don't append) so messages don't accumulate.
    Player.onError((msg) => {
      playerTitle.textContent = basePlayerTitle + (msg ? ` - ${msg}` : '');
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
    // Hide guide if switching away
    if (guideMode && section !== 'guide') {
      Guide.hide();
      guideMode = false;
    }

    currentSection = section === 'guide' ? 'live' : section;
    currentCategoryId = null;
    searchInput.value = '';
    channelGrid.innerHTML = '';
    hideCardMenu();
    closeDetail();
    // Sorting only applies to Movies/Series (VOD/series carry added/rating).
    currentSort = 'default';
    sortSelect.value = 'default';
    contentToolbar.classList.toggle('hidden', !(section === 'vod' || section === 'series'));
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
      if (section === 'guide' || section === 'live') categories = await XC.liveCategories();
      else if (section === 'vod') categories = await XC.vodCategories();
      else if (section === 'series') categories = await XC.seriesCategories();

      renderCategories(categories || []);

      if (section === 'guide') {
        guideMode = true;
        if (!currentCategoryId) {
          Guide.showMessage('Select a category to view the programme guide');
        } else {
          allItems = await XC.liveStreams(currentCategoryId);
          Guide.show(allItems);
        }
      } else {
        await loadItems();
      }
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

    if (guideMode) {
      if (!currentCategoryId) {
        Guide.showMessage('Select a category to view the programme guide');
      } else {
        allItems = await XC.liveStreams(currentCategoryId);
        Guide.show(allItems);
      }
    } else {
      await loadItems();
    }

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
      allItems = allItems || [];
      filterItems();
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
      const name = item.name || item.title || '';
      const provided = item.stream_icon || item.cover || '';
      // Channel logos fall back to the bundled pack when the provider's URL is
      // missing or its host is dead/blocked; posters use their own artwork only.
      const local = isPoster ? '' : XC.localLogo(name);
      const imgSrc = provided || local;

      let sub = '';
      if (currentSection === 'live') {
        sub = item.category_name || '';
      } else if (currentSection === 'vod' || currentSection === 'series') {
        let rate = item.imdb_rating;
        // Show the weighted score on the tile when that's what we're sorting by.
        if (rate && currentSort === 'imdb') rate = imdbWeighted(item).toFixed(1);
        sub = rate ? `★ ${rate} IMDb` : (item.year ? String(item.year) : '');
      }

      card.innerHTML = `
        <div class="card-thumb${isPoster ? ' poster' : ''}">
          ${imgSrc ? `<img class="card-img" src="${escHtml(imgSrc)}" data-local="${escHtml(local)}" alt="" loading="lazy" onerror="window.__logoFallback(this)">` : ''}
        </div>
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
      card.addEventListener('contextmenu', (e) => { e.preventDefault(); showCardMenu(e, item); });
      frag.appendChild(card);
    });

    channelGrid.appendChild(frag);
  }

  // Sort the grid. Movies carry `added` (unix ts) + `year`; series carry
  // `last_modified` + `year`. Rating is TMDB-sourced and heavily clustered
  // (~6.5 for everything), so it's deliberately not offered.
  const itemName = (i) => i.name || i.title || '';

  // IMDb weighted (Bayesian) rating: a 9.0 with 12 votes shouldn't beat an 8.4
  // with 500k. Items without an IMDb match sort to the bottom.
  const IMDB_C = 7.0, IMDB_M = 1000;
  function imdbWeighted(i) {
    const r = i.imdb_rating, v = i.imdb_votes || 0;
    if (!r) return -1;
    return (v / (v + IMDB_M)) * r + (IMDB_M / (v + IMDB_M)) * IMDB_C;
  }

  // IMDb raw rating, but only count titles with at least this many votes (so a
  // 9.x from a handful of votes is ignored). Low cutoff so newer well-rated
  // titles still surface, even if a bit gamed.
  const IMDB_RAW_MIN_VOTES = 500;
  function imdbRaw(i) {
    return (i.imdb_rating && (i.imdb_votes || 0) >= IMDB_RAW_MIN_VOTES) ? i.imdb_rating : -1;
  }

  function sortItems(items) {
    if (currentSort === 'default') return items;
    const arr = items.slice();
    if (currentSort === 'recent') {
      arr.sort((a, b) => (Number(b.added || b.last_modified) || 0) - (Number(a.added || a.last_modified) || 0));
    } else if (currentSort === 'year') {
      arr.sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0) || itemName(a).localeCompare(itemName(b)));
    } else if (currentSort === 'imdb') {
      arr.sort((a, b) => imdbWeighted(b) - imdbWeighted(a));
    } else if (currentSort === 'imdb_raw') {
      arr.sort((a, b) => imdbRaw(b) - imdbRaw(a) || (b.imdb_votes || 0) - (a.imdb_votes || 0));
    } else if (currentSort === 'name') {
      arr.sort((a, b) => itemName(a).localeCompare(itemName(b)));
    }
    return arr;
  }

  function filterItems() {
    const q = searchInput.value.toLowerCase().trim();
    const list = allItems || [];
    if (guideMode) {
      const filtered = q ? list.filter(item => (item.name || '').toLowerCase().includes(q)) : list;
      Guide.show(filtered);
      return;
    }
    const filtered = q
      ? list.filter(item => (item.name || item.title || '').toLowerCase().includes(q))
      : list;
    renderItems(sortItems(filtered));
  }

  // ===== Item Click Handlers =====
  async function handleItemClick(item) {
    if (currentSection === 'live') {
      await playLive(item);
    } else if (currentSection === 'vod') {
      openMovieDetail(item);              // info first; Play lives in the drawer
    } else if (currentSection === 'series') {
      await showSeries(item);
    } else if (currentSection === 'favorites') {
      const favData = item._favData;
      if (favData.type === 'live') await playLive(favData.item);
      else if (favData.type === 'vod') openMovieDetail(favData.item);
      else if (favData.type === 'series') await showSeries(favData.item);
    } else if (currentSection === 'history') {
      const histData = item._histData;
      if (histData.type === 'live') await playLive(histData.item);
      else if (histData.type === 'vod') openMovieDetail(histData.item);
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
      url = await transcodeSourceUrl(item.stream_id, 'live', item, { forceVideo: getRememberedVideoFix(String(item.stream_id)) });
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
    ensureDuration(item, 'vod'); // probe runtime so audio-fix can use seekable HLS

    let url;
    currentFormatIndex = 0;

    if (remembered === 'transcode' && transcodeAvailable) {
      url = await transcodeSourceUrl(item.stream_id, 'vod', item, { forceVideo: getRememberedVideoFix(String(item.stream_id)) });
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
    ensureDuration(episode, 'series'); // probe runtime so audio-fix can use seekable HLS

    let url;
    currentFormatIndex = 0;

    if (remembered === 'transcode' && transcodeAvailable) {
      url = await transcodeSourceUrl(episode.id, 'series', episode, { forceVideo: getRememberedVideoFix(String(episode.id)) });
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
    basePlayerTitle = title;
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
    // Unknown length (transcoded stream plays as a live feed → duration is
    // Infinity) — show elapsed only, no bogus total.
    if (!isFinite(dur) || dur <= 0) {
      $('progress-fill').style.width = '0%';
      $('time-display').textContent = fmtTime(cur);
      return;
    }
    const pct = (cur / dur) * 100;
    $('progress-fill').style.width = pct + '%';
    $('time-display').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
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

  // Best-effort runtime (seconds) for a VOD item / series episode.
  function itemDurationSecs(item) {
    if (!item) return 0;
    if (Number(item._durationSecs) > 0) return Number(item._durationSecs); // probed
    const info = item.info || {};
    if (Number(info.duration_secs) > 0) return Number(info.duration_secs);
    if (typeof info.duration === 'string') {
      const m = info.duration.match(/(\d+):(\d{2}):(\d{2})/);
      if (m) { const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]); if (t > 0) return t; }
    }
    const ert = parseInt(item.episode_run_time, 10);
    return ert > 0 ? ert * 60 : 0;
  }

  // Transcode source: prefer the SEEKABLE HLS remux for VOD/series. Awaits the
  // runtime probe so HLS engages even when metadata has no duration (series);
  // only falls back to the live MPEG-TS pipe if the runtime is truly unknown.
  async function transcodeSourceUrl(streamId, type, item, opts = {}) {
    const container = item && item.container_extension;
    if (type !== 'live') {
      await ensureDuration(item, type);
      // The HLS transcode already re-encodes video to H.264, so it covers
      // forceVideo (MPEG-2/HEVC) too.
      const hls = XC.hlsTranscodeUrl(streamId, type, container, itemDurationSecs(item));
      if (hls) return hls;
    }
    // Live (or duration-less fallback): re-encode video only when asked (a codec
    // the browser can't decode), otherwise copy video for zero quality loss.
    return XC.transcodeUrl(streamId, type, container, opts.forceVideo ? { vcodec: 'h264' } : undefined);
  }

  // Probe + cache the runtime so the seekable HLS transcode can be used even
  // when Xtream metadata lacks a duration (e.g. series episodes). Fire-and-forget;
  // if it doesn't return in time, transcode falls back to the live pipe.
  async function ensureDuration(item, type) {
    if (!item || type === 'live' || itemDurationSecs(item) > 0) return;
    try {
      const secs = await XC.probeDuration(String(item.stream_id || item.id), type, item.container_extension);
      if (secs > 0) item._durationSecs = secs;
    } catch { /* ignore — falls back to live pipe */ }
  }

  // Hand the current stream to a native external player (VLC/IINA/mpv) — the
  // escape hatch for codecs the browser can't decode (e.g. HEVC video).
  async function openCurrentExternal() {
    if (!currentPlayingItem) return;
    const it = currentPlayingItem.item;
    const raw = XC.rawStreamUrl(String(it.stream_id || it.id), currentPlayingItem.type, it.container_extension);
    if (!raw) return;
    try {
      const r = await XC.openExternal(raw);
      showToast(`Opened in ${r.player || 'external player'}`);
    } catch (e) {
      showToast(e.message || 'No external player found — install VLC');
    }
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
        url = await transcodeSourceUrl(streamId, type, item);
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

  function rememberFormat(streamId, format, opts) {
    const prev = formatMemory[streamId] || {};
    // vfix (video re-encode needed) is sticky: once a channel is known to need
    // H.264 re-encode, keep that flag on later remembers (e.g. the audio path)
    // unless explicitly set, so replays skip the detect-and-switch flip.
    const vfix = opts && opts.vfix ? true : !!prev.vfix;
    formatMemory[streamId] = { fmt: format, vfix, ts: Date.now() };
    saveFormatMemory();
  }

  function getRememberedFormat(streamId) {
    const entry = formatMemory[streamId];
    return entry ? entry.fmt : null;
  }

  function getRememberedVideoFix(streamId) {
    const entry = formatMemory[streamId];
    return !!(entry && entry.vfix);
  }

  // ===== Audio Auto-Detection =====
  // Monitors audio decode health after playback starts.
  // If video plays but no audio bytes are decoded (AC3/EAC3/DTS/Atmos),
  // automatically switches to HLS format which the server transcodes to AAC.
  function startAudioHealthCheck() {
    stopAudioHealthCheck();
    audioAutoSwitched = false;
    videoAutoSwitched = false;
    videoFallbackOffered = false;
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

  // Switch the current stream to a video-re-encoding transcode (H.264). Used when
  // the browser can't decode the source video codec (MPEG-2 / HEVC).
  async function switchToVideoTranscode() {
    const item = currentPlayingItem.item;
    const streamId = String(item.stream_id || item.id);
    const type = currentPlayingItem.type;
    videoAutoSwitched = true;
    const cycle = getFormatCycle();
    const transcodeIndex = cycle.indexOf('transcode');
    if (transcodeIndex !== -1) currentFormatIndex = transcodeIndex;
    rememberFormat(streamId, 'transcode', { vfix: true });
    showFormatSwitch('Video codec unsupported — re-encoding to H.264…', 'Video Fix');
    const url = await transcodeSourceUrl(streamId, type, item, { forceVideo: true });
    if (url) {
      Player.play(url, type === 'live');
      resetIdle();
    }
  }

  async function checkAudioHealth() {
    if (!currentPlayingItem) return;

    // No decoded video frames → the video codec can't be decoded in-app
    // (e.g. MPEG-2 on some live channels, HEVC). Re-encode to H.264 via FFmpeg —
    // works for live + VOD/series. VLC hint only if transcoding is unavailable.
    if (!videoAutoSwitched && Player.getVideoHealth() === 'novideo') {
      if (transcodeAvailable) {
        await switchToVideoTranscode();
        return;
      } else if (!videoFallbackOffered) {
        videoFallbackOffered = true;
        showToast('Video codec not supported in-app — tap ↗ to open in VLC');
      }
    }
    if (audioAutoSwitched) return;

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

      const url = await transcodeSourceUrl(streamId, type, item);
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

      const url = await transcodeSourceUrl(streamId, type, item);
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
    if (reminder) {
      watchBtn.style.display = '';
      watchBtn.onclick = () => {
        hideToast();
        playLive({ stream_id: reminder.itemStreamId, name: reminder.itemName || reminder.channelName });
      };
    } else {
      // Plain info toast (e.g. "no episodes") — no Watch action.
      watchBtn.style.display = 'none';
      watchBtn.onclick = null;
    }

    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, reminder ? 15000 : 4000);
  }

  function hideToast() {
    reminderToast.classList.add('hidden');
    clearTimeout(toastTimer);
  }

  // ===== Series =====
  async function showSeries(item) {
    // Fetch FIRST, decide SECOND — so an episode-less series never flashes the
    // overlay open then closed; it just vanishes from the grid.
    showLoading(true);
    let data;
    try {
      data = await XC.seriesInfo(item.series_id);
    } catch (e) {
      showLoading(false);
      seriesOverlay.classList.remove('hidden');
      seriesTitle.textContent = item.name || item.title || 'Series';
      seriesInfo.innerHTML = '';
      seasonTabs.innerHTML = '';
      episodeListEl.innerHTML = '<div class="no-results">Failed to load series</div>';
      return;
    }

    showLoading(false);
    const info = data.info || {};
    const episodes = data.episodes || {};
    const seasons = Object.keys(episodes).sort((a, b) => Number(a) - Number(b));

    // Provider returned no playable episodes (often a temporary provider gap).
    // Just inform — leave the tile so it works again when episodes return.
    if (!seasons.length) {
      showToast('Currently no episodes available');
      return;
    }

    seriesOverlay.classList.remove('hidden');
    seriesTitle.textContent = item.name || item.title || 'Series';
    seasonTabs.innerHTML = '';
    episodeListEl.innerHTML = '';
    seriesInfo.innerHTML = `
      ${info.cover ? `<img src="${escHtml(info.cover)}" alt="" onerror="this.style.display='none'">` : ''}
      <div class="info-text">
        <h2>${escHtml(info.name || item.name || '')}</h2>
        ${info.genre ? `<p><strong>Genre:</strong> ${escHtml(info.genre)}</p>` : ''}
        ${info.rating ? `<p><strong>Rating:</strong> ${escHtml(String(info.rating))}</p>` : ''}
        ${info.plot ? `<p>${escHtml(info.plot)}</p>` : ''}
        ${info.cast ? `<p><strong>Cast:</strong> ${escHtml(info.cast)}</p>` : ''}
      </div>
    `;

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
        ${ep.info?.duration ? `<span class="ep-duration">${escHtml(String(ep.info.duration))}</span>` : ''}
        ${progressHtml}
      `;
      div.addEventListener('click', () => {
        seriesOverlay.classList.add('hidden');
        playSeries(ep, seriesName);
      });
      episodeListEl.appendChild(div);
    });
  }

  // ===== Right-click context menu =====
  // Resolve the real {type, item} for a grid tile (Favourites/History tiles
  // wrap the original item).
  function resolveItemRef(item) {
    if (currentSection === 'favorites' && item._favData) {
      return { type: item._favData.type, item: item._favData.item };
    }
    if (currentSection === 'history' && item._histData) {
      return { type: item._histData.type, item: item._histData.item };
    }
    return { type: currentSection, item };
  }

  function showCardMenu(e, item) {
    const { type, item: realItem } = resolveItemRef(item);
    const fav = isFavorite(type, realItem);

    cardMenu.innerHTML = '';
    const favBtn = document.createElement('button');
    favBtn.className = 'card-menu-item';
    favBtn.textContent = fav ? '☆  Remove from Favourites' : '★  Add to Favourites';
    favBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFavorite(type, realItem);
      hideCardMenu();
      // Refresh so the star (and the Favourites grid) reflect the change.
      if (currentSection === 'favorites') renderFavorites();
      else filterItems();
    });
    cardMenu.appendChild(favBtn);

    // Show, then clamp within the viewport.
    cardMenu.classList.remove('hidden');
    const rect = cardMenu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    cardMenu.style.left = `${Math.max(8, x)}px`;
    cardMenu.style.top = `${Math.max(8, y)}px`;
  }

  function hideCardMenu() {
    if (cardMenu) cardMenu.classList.add('hidden');
  }

  // ===== Movie detail drawer =====
  function fmtRuntime(mins) {
    const m = parseInt(mins, 10);
    if (!m) return '';
    const h = Math.floor(m / 60), r = m % 60;
    return h ? `${h}h ${r}m` : `${r}m`;
  }
  function fmtVotes(v) {
    if (!v) return '';
    if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(v);
  }

  function openMovieDetail(item) {
    hideCardMenu();
    const name = item.name || item.title || '';
    const img = item.stream_icon || item.cover || '';
    const meta = [item.year, fmtRuntime(item.episode_run_time), item.genre].filter(Boolean).join(' · ');
    const imdb = item.imdb_rating
      ? `<div class="detail-rating">★ ${escHtml(String(item.imdb_rating))} <span>IMDb</span>${item.imdb_votes ? ` · ${fmtVotes(item.imdb_votes)} votes` : ''}</div>`
      : '';
    detailBody.innerHTML = `
      <div class="detail-top">
        ${img ? `<img class="detail-poster" src="${escHtml(img)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="detail-main">
          <h2 class="detail-title">${escHtml(name)}</h2>
          <div class="detail-cols">
            <div class="detail-colL">
              ${meta ? `<div class="detail-meta">${escHtml(meta)}</div>` : ''}
              ${imdb}
            </div>
            <div class="detail-colR">
              ${item.cast ? `<div class="detail-extra" title="${escHtml(item.cast)}"><strong>Cast:</strong> ${escHtml(item.cast)}</div>` : ''}
              ${item.director ? `<div class="detail-extra" title="${escHtml(item.director)}"><strong>Director:</strong> ${escHtml(item.director)}</div>` : ''}
            </div>
          </div>
          <div class="detail-actions">
            <button id="detail-play" class="detail-play">▶ Play</button>
            <button id="detail-fav" class="detail-fav"></button>
          </div>
        </div>
      </div>
      <p class="detail-plot">${escHtml(item.plot || '')}</p>
    `;
    const favBtn = $('detail-fav');
    const syncFav = () => { favBtn.textContent = isFavorite('vod', item) ? '★ Favourited' : '☆ Favourite'; };
    syncFav();
    $('detail-play').addEventListener('click', () => { closeDetail(); playVod(item); });
    favBtn.addEventListener('click', () => {
      toggleFavorite('vod', item);
      syncFav();
      if (currentSection === 'favorites') renderFavorites();
    });
    detailDrawer.classList.remove('hidden');
  }

  function closeDetail() {
    if (detailDrawer) detailDrawer.classList.add('hidden');
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

  // Public API for Guide module
  return {
    playLiveFromGuide: (stream) => playLive(stream),
    openCatchupPlayer: (channelName, progTitle, url) => {
      currentPlayingItem = { type: 'live', item: { name: channelName } };
      // Catch-up is a finite MPEG-TS stream. Pass live=false: player.js routes
      // .ts URLs through mpegts.js (native <video> can't decode raw .ts) while
      // treating it as finite (no live-edge chasing).
      openPlayer(`${channelName} — ${progTitle} (Catch-Up)`, url, false);
      epgPanel.classList.add('hidden');
    },
    isReminderSet: (key) => !!reminders[key],
    toggleReminderFromGuide: (programme, stream) => {
      setReminder(programme, stream.stream_id, stream.name, stream);
    },
    getCurrentStreamId: () => currentPlayingItem?.item?.stream_id || null,
  };
})();
