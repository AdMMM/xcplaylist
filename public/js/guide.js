// EPG Timeline Guide — virtualised, performance-first
const Guide = (() => {
  const ROW_H = 48;
  const PX_PER_MIN = 4;
  const PAST_HOURS = 6;
  const TOTAL_HOURS = 24;
  const SLOT_MINS = 30;
  const BUFFER_ROWS = 5;

  let visible = false;
  let channelData = [];       // pre-computed: [{stream, epgChannelId, programmes: [{...leftPx, widthPx}]}]
  let timelineStart = null;
  let timelineEnd = null;
  let totalWidth = 0;
  let nowLineInterval = null;
  let rafId = null;
  let renderedRange = { first: -1, last: -1 };
  let hoverTimeout = null;

  // DOM refs
  let container, nowBtn, dateLabel, timeHeaders, body, channels, programmes, nowLine, hoverCard;

  function $(id) { return document.getElementById(id); }

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function init() {
    container = $('guide-container');
    nowBtn = $('guide-now-btn');
    dateLabel = $('guide-date-label');
    timeHeaders = $('guide-time-headers');
    body = $('guide-body');
    channels = $('guide-channels');
    programmes = $('guide-programmes');
    nowLine = $('guide-now-line');
    hoverCard = $('guide-hover-card');

    // Sync scroll: programmes → time headers (horizontal) + channels (vertical)
    let scrollSource = null;
    programmes.addEventListener('scroll', () => {
      if (scrollSource === 'channels') return;
      scrollSource = 'programmes';
      timeHeaders.scrollLeft = programmes.scrollLeft;
      channels.scrollTop = programmes.scrollTop;
      updateNowBtnState();
      scheduleRender();
      scrollSource = null;
    });

    // Sync scroll: channels → programmes (vertical) for mousewheel over channel column
    channels.addEventListener('scroll', () => {
      if (scrollSource === 'programmes') return;
      scrollSource = 'channels';
      programmes.scrollTop = channels.scrollTop;
      updateNowBtnState();
      scheduleRender();
      scrollSource = null;
    });

    nowBtn.addEventListener('click', scrollToNow);

    // Event delegation on programmes container
    programmes.addEventListener('mouseover', onProgHover);
    programmes.addEventListener('mouseout', onProgOut);
    programmes.addEventListener('click', onProgClick);

    // Hover card mouse events
    hoverCard.addEventListener('mouseenter', () => clearTimeout(hoverTimeout));
    hoverCard.addEventListener('mouseleave', hideHoverCard);
  }

  function show(streams) {
    visible = true;
    hideHoverCard();

    // Clear previously rendered rows to prevent overlapping on re-render
    channels.innerHTML = '';
    programmes.querySelectorAll('.guide-prog-row').forEach(r => r.remove());
    renderedRange = { first: -1, last: -1 };

    const now = new Date();
    timelineStart = new Date(now);
    timelineStart.setMinutes(0, 0, 0);
    timelineStart.setHours(timelineStart.getHours() - PAST_HOURS);
    timelineEnd = new Date(timelineStart.getTime() + TOTAL_HOURS * 3600000);
    totalWidth = TOTAL_HOURS * 60 * PX_PER_MIN;

    // Pre-compute channel data
    channelData = [];
    for (const stream of streams) {
      const epgChannelId = stream.epg_channel_id || null;
      let progs = [];

      if (epgChannelId) {
        const raw = EPG.getTimelineProgrammes(epgChannelId, timelineStart, timelineEnd);
        progs = raw.map(p => {
          const clampStart = p.start < timelineStart ? timelineStart : p.start;
          const clampEnd = p.stop > timelineEnd ? timelineEnd : p.stop;
          const leftPx = ((clampStart - timelineStart) / 60000) * PX_PER_MIN;
          const widthPx = ((clampEnd - clampStart) / 60000) * PX_PER_MIN;
          return { ...p, leftPx, widthPx };
        });
      }

      channelData.push({ stream, epgChannelId, programmes: progs });
    }

    // Show container, hide grid, restore spacer visibility
    container.classList.remove('hidden');
    $('channel-grid').classList.add('hidden');
    const existingProgSpacer = programmes.querySelector('.guide-spacer');
    if (existingProgSpacer) existingProgSpacer.style.display = '';
    const existingChSpacer = channels.querySelector('.guide-ch-spacer');
    if (existingChSpacer) existingChSpacer.style.display = '';

    // Date label
    dateLabel.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

    renderTimeHeaders();
    setupScrollArea();
    renderVisibleRows(true);
    updateNowLine();
    scrollToNow();

    clearInterval(nowLineInterval);
    nowLineInterval = setInterval(() => {
      updateNowLine();
      updateProgressBars();
    }, 30000);
  }

  function hide() {
    visible = false;
    container.classList.add('hidden');
    $('channel-grid').classList.remove('hidden');
    clearInterval(nowLineInterval);
    hideHoverCard();
    // Clear rendered rows
    channels.innerHTML = '';
    programmes.querySelectorAll('.guide-prog-row').forEach(r => r.remove());
    renderedRange = { first: -1, last: -1 };
  }

  function renderTimeHeaders() {
    timeHeaders.innerHTML = '';
    timeHeaders.style.width = totalWidth + 'px';
    const slotW = SLOT_MINS * PX_PER_MIN;
    const count = (TOTAL_HOURS * 60) / SLOT_MINS;
    const frag = document.createDocumentFragment();

    for (let i = 0; i < count; i++) {
      const t = new Date(timelineStart.getTime() + i * SLOT_MINS * 60000);
      const mark = document.createElement('div');
      mark.className = 'guide-time-mark';
      mark.style.width = slotW + 'px';
      mark.textContent = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      frag.appendChild(mark);
    }
    timeHeaders.appendChild(frag);
  }

  function setupScrollArea() {
    const totalH = channelData.length * ROW_H;

    // Channel spacer — gives channels container scrollable content height
    let chSpacer = channels.querySelector('.guide-ch-spacer');
    if (!chSpacer) {
      chSpacer = document.createElement('div');
      chSpacer.className = 'guide-ch-spacer';
      chSpacer.style.cssText = 'position:absolute;top:0;left:0;width:1px;pointer-events:none;';
      channels.appendChild(chSpacer);
    }
    chSpacer.style.height = totalH + 'px';

    // Programme spacer — gives programmes container scrollable width + height
    let spacer = programmes.querySelector('.guide-spacer');
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.className = 'guide-spacer';
      spacer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
      programmes.appendChild(spacer);
    }
    spacer.style.width = totalWidth + 'px';
    spacer.style.height = totalH + 'px';
  }

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      renderVisibleRows(false);
    });
  }

  function renderVisibleRows(force) {
    const scrollTop = programmes.scrollTop;
    const viewH = programmes.clientHeight;
    let first = Math.floor(scrollTop / ROW_H) - BUFFER_ROWS;
    let last = Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER_ROWS;
    first = Math.max(0, first);
    last = Math.min(channelData.length - 1, last);

    if (!force && first === renderedRange.first && last === renderedRange.last) return;

    const oldFirst = renderedRange.first;
    const oldLast = renderedRange.last;
    renderedRange = { first, last };

    // Remove rows outside new range
    if (oldFirst >= 0) {
      for (let i = oldFirst; i <= oldLast; i++) {
        if (i < first || i > last) {
          removeRow(i);
        }
      }
    }

    // Add rows in new range
    for (let i = first; i <= last; i++) {
      if (i < oldFirst || i > oldLast || force) {
        addRow(i);
      }
    }
  }

  function addRow(idx) {
    const data = channelData[idx];
    const topPx = idx * ROW_H;

    // Channel row
    const ch = document.createElement('div');
    ch.className = 'guide-ch-row';
    ch.dataset.idx = idx;
    ch.style.top = topPx + 'px';

    const currentStreamId = App && App.getCurrentStreamId ? App.getCurrentStreamId() : null;
    if (currentStreamId && currentStreamId === data.stream.stream_id) {
      ch.classList.add('guide-ch-playing');
    }

    let chHtml = '';
    if (data.stream.stream_icon) {
      chHtml += `<img class="guide-ch-icon" src="${escHtml(data.stream.stream_icon)}" alt="" loading="lazy" onerror="this.style.display='none'">`;
    }
    chHtml += `<span class="guide-ch-name">${escHtml(data.stream.name)}</span>`;
    if (data.stream.tv_archive == 1) {
      chHtml += '<span class="guide-ch-catchup" title="Catch-up available">&#x23F2;</span>';
    }
    ch.innerHTML = chHtml;
    ch.addEventListener('click', () => {
      if (App && App.playLiveFromGuide) App.playLiveFromGuide(data.stream);
    });
    channels.appendChild(ch);

    // Programme row
    const row = document.createElement('div');
    row.className = 'guide-prog-row';
    row.dataset.idx = idx;
    row.style.top = topPx + 'px';
    row.style.width = totalWidth + 'px';

    if (!data.programmes.length) {
      row.innerHTML = `<div class="guide-prog-block prog-future" style="width:${totalWidth}px"><span class="guide-prog-name" style="color:var(--text-dim)">No programme data</span></div>`;
      programmes.appendChild(row);
      return;
    }

    const now = new Date();
    const hasCatchup = data.stream.tv_archive == 1;
    const catchupHours = data.stream.tv_archive_duration || 0;
    const catchupCutoff = hasCatchup ? new Date(now.getTime() - catchupHours * 3600000) : null;

    const frag = document.createDocumentFragment();
    let lastEndPx = 0;

    for (let pi = 0; pi < data.programmes.length; pi++) {
      const prog = data.programmes[pi];

      // Fill gap
      if (prog.leftPx > lastEndPx + 1) {
        const gap = document.createElement('div');
        gap.className = 'guide-prog-block prog-past-no-catchup';
        gap.style.width = (prog.leftPx - lastEndPx) + 'px';
        frag.appendChild(gap);
      }

      const block = document.createElement('div');
      block.className = 'guide-prog-block';
      block.style.width = Math.max(prog.widthPx, 2) + 'px';
      block.dataset.row = idx;
      block.dataset.prog = pi;

      // Visual state
      if (prog.isNow) {
        block.classList.add('prog-now');
        const elapsed = (now - prog.start) / (prog.stop - prog.start) * 100;
        const bar = document.createElement('div');
        bar.className = 'guide-prog-progress';
        bar.style.width = Math.min(elapsed, 100) + '%';
        block.appendChild(bar);
      } else if (prog.isFuture) {
        block.classList.add('prog-future');
      } else if (prog.isPast && hasCatchup && catchupCutoff && prog.stop > catchupCutoff) {
        block.classList.add('prog-past-catchup');
      } else {
        block.classList.add('prog-past-no-catchup');
      }

      // Programme name (skip text for very narrow blocks)
      const nameSpan = document.createElement('span');
      nameSpan.className = 'guide-prog-name';
      if (prog.widthPx > 40) {
        nameSpan.textContent = prog.title;
      }
      block.appendChild(nameSpan);

      // Reminder icon
      if (prog.isFuture && App && App.isReminderSet) {
        const key = `${data.stream.stream_id}:${prog.start.getTime()}`;
        if (App.isReminderSet(key)) {
          const icon = document.createElement('span');
          icon.className = 'guide-prog-reminder';
          icon.textContent = '\u{1F514}';
          block.appendChild(icon);
        }
      }

      frag.appendChild(block);
      lastEndPx = prog.leftPx + prog.widthPx;
    }

    // Fill trailing gap
    if (lastEndPx < totalWidth) {
      const gap = document.createElement('div');
      gap.className = 'guide-prog-block prog-future';
      gap.style.width = (totalWidth - lastEndPx) + 'px';
      frag.appendChild(gap);
    }

    row.appendChild(frag);
    programmes.appendChild(row);
  }

  function removeRow(idx) {
    const ch = channels.querySelector(`.guide-ch-row[data-idx="${idx}"]`);
    if (ch) ch.remove();
    const pr = programmes.querySelector(`.guide-prog-row[data-idx="${idx}"]`);
    if (pr) pr.remove();
  }

  function updateNowLine() {
    const now = new Date();
    if (now < timelineStart || now > timelineEnd) {
      nowLine.style.display = 'none';
      return;
    }
    nowLine.style.display = '';
    const leftPx = ((now - timelineStart) / 60000) * PX_PER_MIN;
    nowLine.style.left = leftPx + 'px';
  }

  function scrollToNow() {
    const now = new Date();
    const nowPx = ((now - timelineStart) / 60000) * PX_PER_MIN;
    const visibleW = programmes.clientWidth;
    programmes.scrollLeft = nowPx - visibleW / 2;
    updateNowBtnState();
  }

  function updateNowBtnState() {
    const now = new Date();
    const nowPx = ((now - timelineStart) / 60000) * PX_PER_MIN;
    const center = programmes.scrollLeft + programmes.clientWidth / 2;
    const near = Math.abs(nowPx - center) < programmes.clientWidth / 4;
    nowBtn.classList.toggle('dimmed', near);
  }

  function updateProgressBars() {
    if (!visible) return;
    const now = new Date();
    const blocks = programmes.querySelectorAll('.prog-now .guide-prog-progress');
    blocks.forEach(bar => {
      const block = bar.parentElement;
      const ri = parseInt(block.dataset.row);
      const pi = parseInt(block.dataset.prog);
      if (isNaN(ri) || isNaN(pi)) return;
      const prog = channelData[ri]?.programmes[pi];
      if (!prog) return;
      const elapsed = (now - prog.start) / (prog.stop - prog.start) * 100;
      bar.style.width = Math.min(elapsed, 100) + '%';
    });
  }

  // --- Event delegation ---

  function findBlock(e) {
    let el = e.target;
    while (el && el !== programmes) {
      if (el.classList && el.classList.contains('guide-prog-block') && el.dataset.row !== undefined) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function onProgHover(e) {
    const block = findBlock(e);
    if (!block || block.dataset.row === undefined) return;
    clearTimeout(hoverTimeout);
    const ri = parseInt(block.dataset.row);
    const pi = parseInt(block.dataset.prog);
    if (isNaN(ri) || isNaN(pi)) return;
    showHoverCard(block, ri, pi);
  }

  function onProgOut(e) {
    // Delay hide to allow mouse to move to hover card
    hoverTimeout = setTimeout(hideHoverCard, 400);
  }

  function onProgClick(e) {
    const block = findBlock(e);
    if (!block || block.dataset.row === undefined) return;
    const ri = parseInt(block.dataset.row);
    const pi = parseInt(block.dataset.prog);
    if (isNaN(ri) || isNaN(pi)) return;

    const data = channelData[ri];
    const prog = data?.programmes[pi];
    if (!data || !prog) return;

    hideHoverCard();

    if (prog.isNow) {
      if (App && App.playLiveFromGuide) App.playLiveFromGuide(data.stream);
    } else if (prog.isFuture) {
      if (App && App.toggleReminderFromGuide) {
        App.toggleReminderFromGuide(prog, data.stream);
      }
      removeRow(ri);
      addRow(ri);
    } else if (prog.isPast) {
      const hasCatchup = data.stream.tv_archive == 1;
      const catchupHours = data.stream.tv_archive_duration || 0;
      const now = new Date();
      const cutoff = hasCatchup ? new Date(now.getTime() - catchupHours * 3600000) : null;
      if (hasCatchup && cutoff && prog.stop > cutoff) {
        playCatchup(prog, data.stream);
      }
    }
  }

  // --- Hover card ---

  function showHoverCard(blockEl, rowIdx, progIdx) {
    clearTimeout(hoverTimeout);
    const data = channelData[rowIdx];
    const prog = data?.programmes[progIdx];
    if (!data || !prog) return;

    const durationMins = Math.round((prog.stop - prog.start) / 60000);
    const hours = Math.floor(durationMins / 60);
    const mins = durationMins % 60;
    const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    hoverCard.querySelector('.ghc-title').textContent = prog.title;
    hoverCard.querySelector('.ghc-time').textContent =
      `${EPG.formatTime(prog.start)} \u2013 ${EPG.formatTime(prog.stop)}`;
    hoverCard.querySelector('.ghc-duration').textContent = durationStr;
    hoverCard.querySelector('.ghc-desc').textContent = prog.desc || '';

    // Position near block — synchronous to avoid frame-delay flicker
    hoverCard.classList.remove('hidden');
    const rect = blockEl.getBoundingClientRect();
    let top = rect.bottom + 2;
    let left = rect.left;

    // Force layout so we can read dimensions immediately
    const cardH = hoverCard.offsetHeight;
    const cardW = hoverCard.offsetWidth;
    if (top + cardH > window.innerHeight) top = rect.top - cardH - 2;
    if (left + cardW > window.innerWidth) left = window.innerWidth - cardW - 8;
    if (left < 4) left = 4;
    if (top < 4) top = 4;
    hoverCard.style.top = top + 'px';
    hoverCard.style.left = left + 'px';
  }

  function hideHoverCard() {
    clearTimeout(hoverTimeout);
    hoverCard.classList.add('hidden');
  }

  // --- Catch-up playback ---

  async function playCatchup(prog, stream) {
    const startTs = Math.floor(prog.start.getTime() / 1000);
    const durationMins = Math.ceil((prog.stop - prog.start) / 60000);
    try {
      const { url } = await XC.catchupUrl(stream.stream_id, startTs, durationMins);
      if (App && App.openCatchupPlayer) {
        App.openCatchupPlayer(stream.name, prog.title, url);
      }
    } catch (e) {
      console.error('[guide] Catch-up failed:', e);
    }
  }

  // --- Public API ---

  function refresh() {
    if (!visible) return;
    const scrollLeft = programmes.scrollLeft;
    const scrollTop = programmes.scrollTop;
    // Remove all rendered rows
    channels.innerHTML = '';
    programmes.querySelectorAll('.guide-prog-row').forEach(r => r.remove());
    renderedRange = { first: -1, last: -1 };
    renderVisibleRows(true);
    programmes.scrollLeft = scrollLeft;
    programmes.scrollTop = scrollTop;
  }

  function showMessage(text) {
    visible = true;
    hideHoverCard();
    channels.innerHTML = '';
    programmes.querySelectorAll('.guide-prog-row').forEach(r => r.remove());
    renderedRange = { first: -1, last: -1 };
    channelData = [];
    container.classList.remove('hidden');
    $('channel-grid').classList.add('hidden');
    dateLabel.textContent = '';
    timeHeaders.innerHTML = '';

    // Show centred message in programme area
    let spacer = programmes.querySelector('.guide-spacer');
    if (spacer) spacer.style.display = 'none';
    nowLine.style.display = 'none';
    const msg = document.createElement('div');
    msg.className = 'guide-prog-row';
    msg.style.cssText = 'position:static;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:14px;';
    msg.textContent = text;
    programmes.appendChild(msg);
  }

  return {
    init,
    show,
    showMessage,
    hide,
    refresh,
    isVisible: () => visible,
  };
})();
