// ─────────────────────────────────────────────────────
//  APP.JS — Orchestrare principala
// ─────────────────────────────────────────────────────

import { calcParams, simulate, calcStats, percentilesPerDay,
         adjustParams, NUM_SIMS, estimateGARCH, estimateNu } from './montecarlo.js';
import { analyzeSentiment, fetchSectorData, fetchVIX } from './sentiment.js';
import { drawPriceHistory, drawTrajectories,
         drawHistogram, drawSentiment, destroyAll, destroyPeriodCharts } from './charts.js';

// ── Service Worker ────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── State ────────────────────────────────────────────
let currentResult = null;

// ── DOM refs ─────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Istoric localStorage ──────────────────────────────
const ISTORIC_KEY = 'istoricSimulari';
const MAX_ISTORIC = 30;

function loadIstoric() {
  try { return JSON.parse(localStorage.getItem(ISTORIC_KEY)) || []; }
  catch { return []; }
}

function saveIstoric(ticker, pret) {
  let istoric = loadIstoric();
  istoric     = istoric.filter(item => item.ticker !== ticker);
  istoric.unshift({
    ticker,
    pret,
    timestamp: new Date().toLocaleString('ro-RO', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    })
  });
  localStorage.setItem(ISTORIC_KEY, JSON.stringify(istoric.slice(0, MAX_ISTORIC)));
}

function renderIstoric() {
  const istoric   = loadIstoric();
  const container = $('history-container');
  const list      = $('history-list');
  if (!container || !list) return;
  if (istoric.length === 0) { container.style.display = 'none'; return; }
  container.style.display = 'flex';
  list.innerHTML = '';
  istoric.forEach(item => {
    const btn          = document.createElement('button');
    btn.className      = 'example-chip';
    btn.title          = `Simulat la: ${item.timestamp}`;
    btn.textContent    = `${item.ticker} (${item.pret})`;
    btn.dataset.ticker = item.ticker;
    btn.addEventListener('click', () => {
      $('ticker-input').value = item.ticker;
      runSimulation();
    });
    list.appendChild(btn);
  });
}

// ── Watchlist "Vandute de urmarit" ───────────────────
const WATCHLIST_KEY = 'watchlistUrmarit';

function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || []; }
  catch { return []; }
}

function saveToWatchlist(entry) {
  let list = loadWatchlist();
  list = list.filter(e => e.ticker !== entry.ticker);
  list.unshift(entry);
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}

// ── Captureaza graficele pentru toate perioadele ──────
// Randeaza chart-uri proprii (nu reutilizeaza drawTrajectories/drawHistogram
// care au variabile de modul trajChart/histChart cu efecte secundare).
async function captureChartsForWatchlist(periodResults, currentPrice, ticker) {
  const captures = {};

  // Container invizibil dar randat de browser (opacity 0.01, nu display:none)
  const tmpDiv = document.createElement('div');
  tmpDiv.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:660px',
    'opacity:0.01', 'pointer-events:none',
    'z-index:99999', 'overflow:visible',
  ].join(';');
  document.body.appendChild(tmpDiv);

  // Compoziteaza pe fundal dark si returneaza JPEG data-URL
  function toJpeg(canvas) {
    try {
      const bg  = document.createElement('canvas');
      bg.width  = canvas.width;
      bg.height = canvas.height;
      const ctx = bg.getContext('2d');
      ctx.fillStyle = '#0d0d1a';
      ctx.fillRect(0, 0, bg.width, bg.height);
      ctx.drawImage(canvas, 0, 0);
      return bg.toDataURL('image/jpeg', 0.82);
    } catch (e) { return null; }
  }

  try {
    for (const days of [30, 90, 180, 360]) {
      const pd = periodResults[days];
      if (!pd) continue;

      // Canvas-uri cu dimensiuni fixe (responsive:false le respecta)
      const trajC = document.createElement('canvas');
      trajC.width = 370; trajC.height = 188;
      const histC = document.createElement('canvas');
      histC.width = 270; histC.height = 188;
      tmpDiv.appendChild(trajC);
      tmpDiv.appendChild(histC);

      let chartTraj = null, chartHist = null;
      try {
        // ── Traiectorii percentile ──────────────────────
        const labels = Array.from({ length: days + 1 }, (_, i) => i);
        chartTraj = new Chart(trajC.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: 'P90', data: Array.from(pd.percs[90]), borderColor: '#66bb6a', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 },
              { label: 'P50', data: Array.from(pd.percs[50]), borderColor: '#ffee58', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 },
              { label: 'P10', data: Array.from(pd.percs[10]), borderColor: '#ef5350', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 },
              { label: `$${currentPrice.toFixed(0)}`, data: Array(days + 1).fill(currentPrice), borderColor: 'rgba(255,255,255,0.3)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
            ],
          },
          options: {
            animation: false,
            responsive: false,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#aaa', font: { size: 9 }, boxWidth: 12 } } },
            scales: {
              x: { ticks: { color: '#555577', maxTicksLimit: 6, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { ticks: { color: '#555577', callback: v => `$${v.toFixed(0)}`, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });

        // ── Histograma distributie finala ───────────────
        const allFinals = Array.from(pd.stats.finals);
        const minVal    = pd.stats.min * 0.95;
        const maxVal    = pd.stats.max * 1.05;
        const nBins     = 40;
        const binSize   = (maxVal - minVal) / nBins;
        const bins      = Array(nBins).fill(0);
        allFinals.forEach(v => {
          const b = Math.min(Math.floor((v - minVal) / binSize), nBins - 1);
          if (b >= 0) bins[b]++;
        });
        chartHist = new Chart(histC.getContext('2d'), {
          type: 'bar',
          data: {
            labels: Array.from({ length: nBins }, (_, i) => (minVal + i * binSize).toFixed(0)),
            datasets: [{
              data: bins,
              backgroundColor: bins.map((_, i) =>
                (minVal + i * binSize) >= currentPrice ? 'rgba(102,187,106,0.7)' : 'rgba(239,83,80,0.7)'
              ),
              borderWidth: 0,
            }],
          },
          options: {
            animation: false,
            responsive: false,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: '#555577', maxTicksLimit: 5, font: { size: 8 } }, grid: { display: false } },
              y: { ticks: { color: '#555577', font: { size: 8 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });
      } catch (drawErr) {
        console.error(`Draw error ${days}d:`, drawErr);
      }

      // Cu animation:false Chart.js randeaza sincron — nu e nevoie de wait lung
      await new Promise(r => setTimeout(r, 60));

      const tj = toJpeg(trajC);
      const hj = toJpeg(histC);
      if (tj || hj) captures[days] = { traj: tj, hist: hj };

      // Curata imediat dupa captura
      try { chartTraj?.destroy(); } catch (_) {}
      try { chartHist?.destroy(); } catch (_) {}
    }
  } finally {
    try { document.body.removeChild(tmpDiv); } catch (_) {}
  }

  return captures;
}

// ── Genereaza HTML pentru graficele unui entry ────────
function chartsHTML(e, forExport = false) {
  if (!e.charts) return '';
  const PERIODS_LIST = [30, 90, 180, 360];
  const imgStyle = forExport
    ? 'width:48%;border-radius:6px;'
    : 'width:48%;border-radius:6px;cursor:zoom-in;';

  return `<div style="margin-top:12px;">
    <div style="font-size:10px;color:rgba(255,255,255,0.30);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px;">
      Traiectorii simulate · Cotatie la salvare: ${e.currency} ${e.price} · ${e.date} ${e.time || ''}
    </div>
    ${PERIODS_LIST.filter(d => e.charts[d]).map(days => `
      <div style="margin-bottom:10px;">
        <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-bottom:4px;font-weight:600;">${days} ZILE</div>
        <div style="display:flex;gap:2%;align-items:flex-start;">
          <img src="${e.charts[days].traj}" style="${imgStyle}" alt="Traj ${days}z">
          <img src="${e.charts[days].hist}" style="${imgStyle}" alt="Hist ${days}z">
        </div>
      </div>
    `).join('')}
  </div>`;
}

// ── Lightbox grafice watchlist ────────────────────────
function ensureLightbox() {
  let lb = $('wl-lightbox');
  if (lb) return lb;
  lb = document.createElement('div');
  lb.id = 'wl-lightbox';
  lb.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.90);z-index:10000;overflow-y:auto;padding:48px 16px 32px;';
  lb.innerHTML = `
    <div style="max-width:840px;margin:auto;position:relative;">
      <button id="wl-lb-close" style="position:fixed;top:14px;right:18px;background:rgba(255,255,255,0.1);
              border:1px solid rgba(255,255,255,0.2);color:#e0e0e0;border-radius:20px;
              padding:6px 16px;cursor:pointer;font-size:13px;font-weight:600;">✕ Închide</button>
      <div id="wl-lb-content"></div>
    </div>`;
  lb.addEventListener('click', e => { if (e.target === lb) lb.style.display = 'none'; });
  lb.querySelector('#wl-lb-close').addEventListener('click', () => { lb.style.display = 'none'; });
  document.body.appendChild(lb);
  return lb;
}

window.openWatchlistCharts = function(idx) {
  const list = loadWatchlist();
  const e    = list[idx];
  if (!e) return;
  const lb      = ensureLightbox();
  const content = $('wl-lb-content');
  const periods  = [30, 90, 180, 360].filter(d => e.charts?.[d]);

  content.innerHTML = `
    <div style="margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <span style="font-size:22px;font-weight:700;color:#e0e0e0;">${e.ticker}</span>
      <span style="font-size:13px;color:rgba(255,255,255,0.40);margin-left:10px;">${e.name}</span><br>
      <span style="font-size:20px;font-weight:700;color:#4fc3f7;">${e.currency} ${e.price}</span>
      <span style="font-size:13px;color:rgba(255,255,255,0.40);margin-left:14px;">${e.date}${e.time ? ' · ' + e.time : ''}</span>
    </div>
    ${periods.length ? periods.map(days => `
      <div style="margin-bottom:22px;">
        <div style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.35);
                    letter-spacing:0.6px;text-transform:uppercase;margin-bottom:8px;">${days} ZILE</div>
        <div style="display:flex;gap:10px;align-items:flex-start;">
          <img src="${e.charts[days].traj}" style="width:58%;border-radius:8px;display:block;" alt="Traj ${days}z">
          <img src="${e.charts[days].hist}" style="width:39%;border-radius:8px;display:block;" alt="Hist ${days}z">
        </div>
      </div>`).join('') : '<div style="color:rgba(255,255,255,0.3);font-size:13px;">Nu există grafice salvate.</div>'}`;

  lb.style.display = 'block';
  lb.scrollTop = 0;
};

function renderWatchlist() {
  const list    = loadWatchlist();
  const cards   = $('watchlist-cards');
  const empty   = $('watchlist-empty');
  const countEl = $('watchlist-count');
  if (!cards) return;

  if (list.length === 0) {
    empty.style.display = 'block';
    cards.innerHTML     = '';
    if (countEl) countEl.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  if (countEl) { countEl.textContent = list.length; countEl.style.display = 'inline'; }

  const btnBase = 'padding:4px 11px;border-radius:12px;font-size:10.5px;cursor:pointer;font-weight:600;';

  cards.innerHTML = list.map((e, idx) => {
    const hasCharts = e.charts && Object.keys(e.charts).some(k => e.charts[k]);
    return `
    <div data-idx="${idx}" draggable="true"
         style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);
                border-radius:10px;padding:14px 16px;
                transition:opacity 0.15s,border-color 0.15s;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <span title="Trage pentru a reordona"
                style="font-size:18px;color:rgba(255,255,255,0.18);cursor:grab;
                       user-select:none;flex-shrink:0;line-height:1.4;padding-top:1px;">⠿</span>
          <div>
            <span style="font-size:16px;font-weight:700;color:#e0e0e0;">${e.ticker}</span>
            <span style="font-size:12px;color:rgba(255,255,255,0.45);margin-left:8px;">${e.name}</span>
            <span style="font-size:13px;color:#4fc3f7;margin-left:8px;font-weight:600;">${e.currency} ${e.price}</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span style="font-size:10px;color:rgba(255,255,255,0.30);">${e.date}${e.time ? ' ' + e.time : ''}</span>
          ${hasCharts ? `<button onclick="openWatchlistCharts(${idx})"
               style="${btnBase}border:1px solid rgba(79,195,247,0.35);background:rgba(79,195,247,0.08);color:#4fc3f7;">📊 Grafice</button>` : ''}
          <button onclick="removeWatchlistEntry(${idx})"
               style="${btnBase}border:1px solid rgba(239,83,80,0.3);background:transparent;color:#ef5350;">✕</button>
        </div>
      </div>
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;">
        ${e.pills.map(p => `<span style="font-size:10.5px;padding:2px 8px;border-radius:12px;
             border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);
             color:rgba(255,255,255,0.65);">${p}</span>`).join('')}
      </div>
      ${e.comment ? `<div style="margin-top:8px;font-size:11px;color:rgba(255,255,255,0.45);line-height:1.55;">${e.comment}</div>` : ''}
    </div>
  `; }).join('');

  // ── Drag-and-drop reordering ──────────────────────────
  let dragSrc = null;

  Array.from(cards.children).forEach(card => {
    card.addEventListener('dragstart', ev => {
      dragSrc = card;
      ev.dataTransfer.effectAllowed = 'move';
      // Mic delay ca browser-ul sa faca snapshot inainte de opacity change
      setTimeout(() => { card.style.opacity = '0.35'; }, 0);
    });

    card.addEventListener('dragend', () => {
      dragSrc = null;
      Array.from(cards.children).forEach(c => {
        c.style.opacity     = '';
        c.style.borderColor = '';
      });
    });

    card.addEventListener('dragover', ev => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      if (card !== dragSrc) card.style.borderColor = 'rgba(79,195,247,0.55)';
    });

    card.addEventListener('dragleave', () => {
      card.style.borderColor = '';
    });

    card.addEventListener('drop', ev => {
      ev.preventDefault();
      if (!dragSrc || dragSrc === card) return;
      const from = parseInt(dragSrc.dataset.idx);
      const to   = parseInt(card.dataset.idx);
      const lst  = loadWatchlist();
      const [moved] = lst.splice(from, 1);
      lst.splice(to, 0, moved);
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(lst));
      renderWatchlist();
    });
  });
}

window.removeWatchlistEntry = function(idx) {
  let list = loadWatchlist();
  list.splice(idx, 1);
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
  renderWatchlist();
};

function exportWatchlistHTML() {
  const list = loadWatchlist();
  if (!list.length) { alert('Lista e goala!'); return; }

  // CSS comun pentru toate fisierele exportate
  const CSS = `
  * { box-sizing: border-box; }
  body { font-family:'Segoe UI',sans-serif; background:#0d0d1a; color:#e0e0e0;
         padding:32px; max-width:980px; margin:auto; }
  h1   { font-size:22px; color:#4fc3f7; margin-bottom:4px; }
  .meta{ font-size:11px; color:rgba(255,255,255,0.35); margin-bottom:28px; }
  .card{ background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1);
         border-radius:10px; padding:20px 24px; margin-bottom:18px; }
  .card-header{ display:flex; justify-content:space-between; align-items:flex-start;
                flex-wrap:wrap; gap:10px; margin-bottom:12px; }
  .ticker{ font-size:22px; font-weight:700; color:#e0e0e0; margin-right:10px; }
  .name  { font-size:13px; color:rgba(255,255,255,0.45); margin-right:10px; }
  .price { font-size:22px; font-weight:700; color:#4fc3f7; }
  .date  { font-size:15px; font-weight:600; color:rgba(255,255,255,0.55);
           white-space:nowrap; text-align:right; }
  .time  { font-size:12px; color:rgba(255,255,255,0.30); display:block; margin-top:2px; }
  .pills { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px; }
  .pill  { font-size:10.5px; padding:2px 9px; border-radius:12px;
           border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.65); }
  .comment{ font-size:11px; color:rgba(255,255,255,0.42); line-height:1.65; margin-bottom:12px; }
  .charts-grid{ margin-top:14px; }
  .chart-period{ margin-bottom:14px; }
  .period-label{ font-size:10px; font-weight:600; color:rgba(255,255,255,0.35);
                 letter-spacing:0.5px; text-transform:uppercase; margin-bottom:5px; }
  .chart-row{ display:flex; gap:8px; }
  .chart-row img{ width:49%; border-radius:6px; display:block; }`;

  // Genereaza si descarca un fisier HTML per entry
  list.forEach((e, i) => {
    const card = `
    <div class="card">
      <div class="card-header">
        <div>
          <span class="ticker">${e.ticker}</span>
          <span class="name">${e.name}</span><br>
          <span class="price">${e.currency} ${e.price}</span>
        </div>
        <div style="text-align:right;">
          <span class="date">${e.date}</span>
          ${e.time ? `<span class="time">${e.time}</span>` : ''}
        </div>
      </div>
      <div class="pills">${e.pills.map(p => `<span class="pill">${p}</span>`).join('')}</div>
      ${e.comment ? `<div class="comment">${e.comment.replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim()}</div>` : ''}
      ${e.charts ? `
        <div class="charts-grid">
          ${[30,90,180,360].filter(d => e.charts[d]).map(days => `
            <div class="chart-period">
              <div class="period-label">${days} ZILE</div>
              <div class="chart-row">
                <img src="${e.charts[days].traj}" alt="Traj ${days}z">
                <img src="${e.charts[days].hist}" alt="Hist ${days}z">
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>`;

    // JSON embedded pentru import (fara spatii in plus)
    const entryJson = JSON.stringify(e).replace(/<\/script>/gi, '<\\/script>');

    const html = `<!DOCTYPE html>
<html lang="ro"><head><meta charset="UTF-8">
<title>${e.ticker} — urmărit · MC.Stocks</title>
<style>${CSS}</style></head><body>
<script id="mc-data" type="application/json">${entryJson}<\/script>
<h1>📌 ${e.ticker}</h1>
<div class="meta">${e.name} · Salvat ${e.date}${e.time ? ' ' + e.time : ''} · MC.Stocks</div>
${card}
</body></html>`;

    // Decaleaza fiecare download ca browserul sa nu le blocheze
    setTimeout(() => {
      const blob = new Blob([html], { type: 'text/html' });
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `${e.ticker}-urmarit.html`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, i * 300);
  });
}

// ── Import watchlist din fisiere HTML exportate ────────
// Suporta ambele formate: JSON embedded (nou) si HTML vizual (vechi)

function parseWatchlistFromHTML(html, filename) {
  // ── Format nou: JSON embedded ──────────────────────
  const jsonMatch = html.match(/<script[^>]+id="mc-data"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonMatch) {
    try {
      const entry = JSON.parse(jsonMatch[1].trim());
      if (entry && entry.ticker) return entry;
    } catch (_) {}
  }

  // ── Format vechi: parsare HTML vizuala ────────────
  const getText = pat => { const m = html.match(pat); return m ? m[1].trim() : null; };

  // Ticker din <h1> sau din numele fisierului
  const ticker =
    getText(/<h1[^>]*>.*?📌\s*([A-Z0-9.\-]+)/i) ||
    getText(/<span class="ticker">([^<]+)<\/span>/i) ||
    filename.replace(/-urmarit\.html$/i, '').replace(/\.html$/i, '').toUpperCase();
  if (!ticker) return null;

  const name     = getText(/<span class="name">([^<]+)<\/span>/i) || ticker;

  // Pret si moneda
  const priceRaw = getText(/<span class="price">([^<]+)<\/span>/i) || '';
  const priceParts = priceRaw.trim().split(/\s+/);
  const currency = priceParts.length >= 2 ? priceParts[0] : 'USD';
  const price    = priceParts.length >= 2 ? priceParts.slice(1).join(' ') : priceRaw;

  // Data si ora — format nou (span.date + span.time) sau vechi (impreuna)
  const dateRaw  = getText(/<span class="date">([^<]+)<\/span>/i) || '';
  const timeRaw  = getText(/<span class="time">([^<]+)<\/span>/i) ||
                   getText(/<span[^>]*class="time"[^>]*>([^<]+)<\/span>/i) || '';
  // Daca data contine ora separata prin ·
  const dateSplit = dateRaw.split('·').map(s => s.trim());
  const date = dateSplit[0] || '';
  const time = timeRaw || dateSplit[1] || '';

  // Pills
  const pills = [];
  const pillRe = /<span class="pill">([^<]+)<\/span>/gi;
  let pm;
  while ((pm = pillRe.exec(html)) !== null) pills.push(pm[1].trim());

  // Comment (text simplu, fara taguri)
  const commentMatch = html.match(/<div class="comment">([\s\S]*?)<\/div>/i);
  const comment = commentMatch
    ? commentMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : '';

  // Charts — img cu alt="Traj Xz" / "Hist Xz"
  const charts = {};
  const imgRe  = /<img[^>]+src="(data:image\/[^"]+)"[^>]+alt="(Traj|Hist) (\d+)z"/gi;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    const [, src, type, dStr] = im;
    const d = parseInt(dStr);
    if (!charts[d]) charts[d] = {};
    charts[d][type.toLowerCase()] = src;
  }
  // Incearca si ordinea inversa a atributelor (alt inainte de src)
  const imgRe2 = /<img[^>]+alt="(Traj|Hist) (\d+)z"[^>]+src="(data:image\/[^"]+)"/gi;
  while ((im = imgRe2.exec(html)) !== null) {
    const [, type, dStr, src] = im;
    const d = parseInt(dStr);
    if (!charts[d]) charts[d] = {};
    if (!charts[d][type.toLowerCase()]) charts[d][type.toLowerCase()] = src;
  }

  return { ticker, name, price, currency, date, time, pills, comment, charts };
}

function importWatchlistFiles(files) {
  if (!files || !files.length) return;
  let done = 0;
  let imported = 0;

  Array.from(files).forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const entry = parseWatchlistFromHTML(ev.target.result, file.name);
        if (entry && entry.ticker) {
          saveToWatchlist(entry);
          imported++;
        } else {
          console.warn('Nu s-au putut extrage date din:', file.name);
        }
      } catch (err) {
        console.error('Import error:', file.name, err);
      }
      done++;
      if (done === files.length) {
        renderWatchlist();
        if (imported > 0) showSection('watchlist-section');
      }
    };
    reader.readAsText(file);
  });
}

// ── Yahoo Finance via CORS proxy ─────────────────────
async function fetchStockData(ticker) {
  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
  const proxy = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const r     = await fetch(proxy);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data  = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Ticker invalid sau date indisponibile');
  const closes     = result.indicators.quote[0].close.filter(Boolean);
  const volumes    = result.indicators.quote[0].volume || [];
  const timestamps = result.timestamp;
  const dates      = timestamps.map(ts =>
    new Date(ts * 1000).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' })
  ).filter((_, i) => result.indicators.quote[0].close[i] != null);
  const meta = result.meta;

  // Extrage fundamentale din meta (disponibile fara crumb, acelasi apel)
  const sharesRaw = meta.sharesOutstanding ?? null;
  const fundamentals = {
    eps:    meta.epsTrailingTwelveMonths ?? null,
    shares: sharesRaw != null ? sharesRaw / 1e6 : null,
    // FCF, active, cash, datorii nu sunt in chart meta → vin din quoteSummary
  };

  return {
    closes, dates, volumes,
    currentPrice: closes[closes.length - 1],
    ticker:       meta.symbol,
    currency:     meta.currency || 'USD',
    name:         meta.longName || meta.shortName || ticker,
    fundamentals,
  };
}

// ── UI Helpers ───────────────────────────────────────

// Seteaza culoarea unui pill in functie de valori
const PILL_COLORS = {
  green:  'pill--green',
  yellow: 'pill--yellow',
  orange: 'pill--orange',
  red:    'pill--red',
  gray:   'pill--gray',
  purple: 'pill--purple',
};
function setPillColor(pillId, color) {
  const el = document.getElementById(pillId);
  if (!el) return;
  Object.values(PILL_COLORS).forEach(c => el.classList.remove(c));
  if (color && PILL_COLORS[color]) el.classList.add(PILL_COLORS[color]);
}

// ── Volatilitate implicita din optiuni + Put/Call Skew ─
// Sursa primara: Nasdaq API (CORS liber, fara proxy, US stocks)
// Fallback:      Yahoo Finance v7 prin corsproxy / allorigins
async function fetchImpliedVolatility(ticker, currentPrice, onProgress) {

  // Detecteaza daca e ticker US (fara sufix .XX sau -USD)
  const isUS = !ticker.includes('.') && !ticker.includes('-');

  // ── Helper: parse IV de la Nasdaq (format "21.53" sau "--") ──
  function parseNasdaqIV(str) {
    if (!str || str === '--' || str === 'N/A') return null;
    const n = parseFloat(str.replace('%', '').replace(',', ''));
    if (isNaN(n) || n <= 0 || n > 500) return null;
    return n / 100; // Nasdaq da procentul intreg, ex: 21.53 => 0.2153
  }
  function parseStrike(str) {
    if (!str) return null;
    return parseFloat(str.replace('$', '').replace(',', ''));
  }

  // ── Nasdaq API (ticker US fara proxy) ────────────────
  if (isUS) {
    try {
      const NBASE = 'https://api.nasdaq.com/api/quote';
      onProgress?.(`IV: incerc Nasdaq pentru ${ticker}...`);

      // Pasul 1: lista expirari disponibile
      const listUrls = [
        `${NBASE}/${ticker}/option-chain?assetclass=stocks&type=all&limit=1`,
        `https://corsproxy.io/?${encodeURIComponent(`${NBASE}/${ticker}/option-chain?assetclass=stocks&type=all&limit=1`)}`,
      ];
      let expiryList = null;
      for (const u of listUrls) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) continue;
          const d = await r.json();
          const list = d?.data?.expiryList;
          if (list?.length) { expiryList = list; break; }
        } catch (_) {}
      }

      if (expiryList?.length) {
        const now      = Date.now();
        const target30 = now + 30 * 86400000;
        const valid    = expiryList.filter(d => new Date(d).getTime() > now + 7 * 86400000);

        if (valid.length) {
          const nearestExp = valid.reduce((a, b) =>
            Math.abs(new Date(b) - target30) < Math.abs(new Date(a) - target30) ? b : a
          );
          const daysToExp = Math.round((new Date(nearestExp) - now) / 86400000);

          onProgress?.(`IV: Nasdaq — expirare ${nearestExp} (${daysToExp}z), descarc lantul...`);
          // Pasul 2: lantul de optiuni pentru expirarea aleasa
          const chainUrls = [
            `${NBASE}/${ticker}/option-chain?assetclass=stocks&expirydate=${nearestExp}&type=all&money=all&limit=100`,
            `https://corsproxy.io/?${encodeURIComponent(`${NBASE}/${ticker}/option-chain?assetclass=stocks&expirydate=${nearestExp}&type=all&money=all&limit=100`)}`,
          ];
          let rows = null;
          for (const u of chainUrls) {
            try {
              const r = await fetch(u, { signal: AbortSignal.timeout(9000) });
              if (!r.ok) continue;
              const d = await r.json();
              const r2 = d?.data?.table?.rows;
              if (r2?.length) { rows = r2; break; }
            } catch (_) {}
          }

          if (rows?.length) {
            // Strike ATM
            const atmRow = rows.reduce((best, row) => {
              const s = parseStrike(row.strike);
              if (!s) return best;
              const d = Math.abs(s - currentPrice);
              return !best || d < best.d ? { row, d, s } : best;
            }, null);

            if (atmRow) {
              const ivs = [parseNasdaqIV(atmRow.row.c_IV), parseNasdaqIV(atmRow.row.p_IV)]
                .filter(v => v != null && v > 0.01 && v < 5);

              if (ivs.length) {
                const ivAnnual = ivs.reduce((a, b) => a + b, 0) / ivs.length;
                const ivDaily  = ivAnnual / Math.sqrt(252);
                const atmStrike = atmRow.s;

                // Skew OTM
                const putTarget  = currentPrice * 0.93;
                const callTarget = currentPrice * 1.07;
                const otmPutRows  = rows.filter(r => { const s = parseStrike(r.strike); return s && s < currentPrice * 0.98 && s > currentPrice * 0.70; });
                const otmCallRows = rows.filter(r => { const s = parseStrike(r.strike); return s && s > currentPrice * 1.02 && s < currentPrice * 1.30; });

                let skewData = null;
                if (otmPutRows.length && otmCallRows.length) {
                  const otmPutRow  = otmPutRows.reduce((b, r)  => { const s = parseStrike(r.strike); return !b || Math.abs(s - putTarget)  < Math.abs(parseStrike(b.strike) - putTarget)  ? r : b; }, null);
                  const otmCallRow = otmCallRows.reduce((b, r) => { const s = parseStrike(r.strike); return !b || Math.abs(s - callTarget) < Math.abs(parseStrike(b.strike) - callTarget) ? r : b; }, null);
                  const piv = parseNasdaqIV(otmPutRow?.p_IV);
                  const civ = parseNasdaqIV(otmCallRow?.c_IV);
                  if (piv && civ) {
                    skewData = {
                      skew: piv - civ, putIV: piv, callIV: civ,
                      putStrike:  parseStrike(otmPutRow?.strike),
                      callStrike: parseStrike(otmCallRow?.strike),
                    };
                  }
                }
                onProgress?.(`IV: Nasdaq ✓ — IV ${(ivAnnual*100).toFixed(1)}%/an, skew ${skewData ? (skewData.skew*100).toFixed(1)+'%' : 'N/A'}`);
                return { ivAnnual, ivDaily, atmStrike, daysToExp, skewData };
              }
            }
          }
        }
      }
    } catch (e) { console.warn('Nasdaq IV fail:', e.message); }
    onProgress?.(`IV: Nasdaq indisponibil, incerc Yahoo Finance...`);
  }

  // ── Yahoo Finance v7 fallback (cu multiple proxies) ──
  async function tryYahoo(path) {
    const hosts   = ['https://query2.finance.yahoo.com', 'https://query1.finance.yahoo.com'];
    const mkProxy = [
      u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    ];
    for (const h of hosts) for (const mk of mkProxy) {
      try {
        const r = await fetch(mk(`${h}${path}`), { signal: AbortSignal.timeout(9000) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j?.optionChain?.result?.[0]) return j;
      } catch (_) {}
    }
    return null;
  }

  try {
    onProgress?.(`IV: incerc Yahoo Finance v7 (4 proxy-uri)...`);
    const data = await tryYahoo(`/v7/finance/options/${ticker}`);
    if (!data) { onProgress?.(`IV: Yahoo indisponibil — voi estima din VIX`); return null; }
    const result = data.optionChain.result[0];
    const now    = Date.now() / 1000;
    const t30    = now + 30 * 86400;
    const expDates = (result.expirationDates || []).filter(d => d > now + 7 * 86400);
    if (!expDates.length) return null;
    const nearestExp = expDates.reduce((a, b) => Math.abs(b - t30) < Math.abs(a - t30) ? b : a);

    const data2 = await tryYahoo(`/v7/finance/options/${ticker}?date=${nearestExp}`);
    if (!data2) return null;
    const opts = data2?.optionChain?.result?.[0]?.options?.[0];
    if (!opts) return null;

    const calls = (opts.calls || []).filter(c => c.impliedVolatility > 0.01 && c.impliedVolatility < 5);
    const puts  = (opts.puts  || []).filter(p => p.impliedVolatility > 0.01 && p.impliedVolatility < 5);
    if (!calls.length && !puts.length) return null;

    const allStrikes = [...new Set([...calls.map(c => c.strike), ...puts.map(p => p.strike)])].sort((a,b) => a-b);
    const atmStrike  = allStrikes.reduce((a,b) => Math.abs(b - currentPrice) < Math.abs(a - currentPrice) ? b : a);
    const atmCall = calls.find(c => c.strike === atmStrike);
    const atmPut  = puts.find(p  => p.strike === atmStrike);
    const ivs = [atmCall?.impliedVolatility, atmPut?.impliedVolatility].filter(v => v > 0.01 && v < 5);
    if (!ivs.length) return null;

    const ivAnnual  = ivs.reduce((a,b) => a+b, 0) / ivs.length;
    const ivDaily   = ivAnnual / Math.sqrt(252);
    const daysToExp = Math.round((nearestExp - now) / 86400);

    const putTarget  = currentPrice * 0.93;
    const callTarget = currentPrice * 1.07;
    const otmPuts  = puts.filter(p  => p.strike < currentPrice * 0.98 && p.strike > currentPrice * 0.70);
    const otmCalls = calls.filter(c => c.strike > currentPrice * 1.02 && c.strike < currentPrice * 1.30);
    let skewData = null;
    if (otmPuts.length && otmCalls.length) {
      const otmPut  = otmPuts.reduce((a,b)  => Math.abs(b.strike - putTarget)  < Math.abs(a.strike - putTarget)  ? b : a);
      const otmCall = otmCalls.reduce((a,b) => Math.abs(b.strike - callTarget) < Math.abs(a.strike - callTarget) ? b : a);
      if (otmPut?.impliedVolatility > 0.01 && otmCall?.impliedVolatility > 0.01) {
        skewData = {
          skew: otmPut.impliedVolatility - otmCall.impliedVolatility,
          putIV: otmPut.impliedVolatility, callIV: otmCall.impliedVolatility,
          putStrike: otmPut.strike, callStrike: otmCall.strike,
        };
      }
    }
    onProgress?.(`IV: Yahoo ✓ — IV ${(ivAnnual*100).toFixed(1)}%/an, skew ${skewData ? (skewData.skew*100).toFixed(1)+'%' : 'N/A'}`);
    return { ivAnnual, ivDaily, atmStrike, daysToExp, skewData };
  } catch (e) {
    console.warn('Yahoo IV fetch error:', e);
    onProgress?.(`IV: Yahoo eroare — voi estima din VIX`);
    return null;
  }
}

// Combina sigma istorica cu IV dupa orizontul de timp
// IV conteaza mult pe termen scurt (30z), scade spre orizonturi lungi
function blendSigma(sigmaHist, ivDaily, days) {
  if (!ivDaily || ivDaily <= 0) return sigmaHist;
  const ivWeight = Math.max(0.10, Math.min(0.70, 30 / days));
  return ivWeight * ivDaily + (1 - ivWeight) * sigmaHist;
}

// ── Comentariu calitativ bazat pe toti coeficientii ──
function generateQualityComment({ sigma, volAnualPct, nu, garch, drift, deviationPct, volumeTrend, ivData, ivEstimated }) {
  const parts = [];

  // ── 1. Profil de risc ────────────────────────────────
  const riskLabel = volAnualPct < 15 ? 'foarte scazut'
                  : volAnualPct < 25 ? 'scazut'
                  : volAnualPct < 40 ? 'mediu'
                  : volAnualPct < 65 ? 'ridicat'
                  :                    'speculativ';
  const tailNote  = nu < 5  ? ', cozi f. groase — crash-uri posibile'
                  : nu < 8  ? ', cozi groase — risc de socuri extreme'
                  : nu < 15 ? ', cozi moderate'
                  :            '';
  const riskColor = volAnualPct < 25 ? '#66bb6a' : volAnualPct < 45 ? '#ffee58' : '#ef5350';
  parts.push(`<span style="color:${riskColor};font-weight:600;">Risc ${riskLabel}</span> · Vol ${volAnualPct.toFixed(0)}%/an${tailNote}.`);

  // ── 2. Regim GARCH ───────────────────────────────────
  if (garch) {
    const ratio    = garch.sigma0 / garch.sigmaLR;
    const regime   = ratio < 0.80 ? 'Piata calma — volatilitate sub medie istorica'
                   : ratio < 1.10 ? 'Volatilitate in regim normal'
                   : ratio < 1.40 ? 'Piata agitata — volatilitate peste medie'
                   :                'Regim de stres — volatilitate ridicata';
    const persNote = garch.persistence > 0.95 ? ', clustere de risc persistente (reversia e lenta)'
                   : garch.persistence > 0.90 ? ', volatilitate moderat persistenta'
                   : '';
    parts.push(`${regime}${persNote}.`);
  }

  // ── 3. Trend pret + volum ────────────────────────────
  const driftStr = drift > 0.0003  ? 'drift pozitiv puternic'
                 : drift > 0.0001  ? 'drift pozitiv'
                 : drift < -0.0003 ? 'drift negativ puternic'
                 : drift < -0.0001 ? 'drift negativ'
                 :                   'drift neutru';
  const maStr    = deviationPct > 12  ? `pret cu ${deviationPct.toFixed(0)}% peste MA60`
                 : deviationPct < -12 ? `pret cu ${Math.abs(deviationPct).toFixed(0)}% sub MA60`
                 :                      'pret aproape de MA60';
  const vtDetail = volumeTrend?.detail ?? '';
  const vtStr    = vtDetail === 'bullish'            ? ', volum confirma cresterea'
                 : vtDetail === 'bearish'            ? ', volum confirma scaderea'
                 : vtDetail.includes('bullish')      ? ', divergenta bullish la volum'
                 : vtDetail.includes('bearish')      ? ', divergenta bearish la volum'
                 :                                     '';
  parts.push(`Tendinta: ${driftStr}, ${maStr}${vtStr}.`);

  // ── 4. Semnalul optiunilor / IV ──────────────────────
  if (ivData) {
    const ivRatio  = ivData.ivDaily / sigma;
    const ivStr    = ivRatio < 0.85 ? 'Piata nu anticipeaza miscari majore (IV redus)'
                   : ivRatio < 1.20 ? 'Risc anticipat in linie cu trecutul'
                   : ivRatio < 1.60 ? 'Piata pretinde miscare importanta (IV ridicat)'
                   :                  'Tensiune maxima — eveniment major posibil';
    const skew     = ivData.skewData?.skew;
    const skewStr  = skew == null     ? ''
                   : skew > 0.15      ? ', put-uri scumpe — teama puternica de scadere'
                   : skew > 0.07      ? ', skew normal bearish'
                   : skew < 0         ? ', call-uri mai scumpe — sentiment bullish in optiuni'
                   :                    ', skew echilibrat';
    const estStr   = ivEstimated ? ' <span style="opacity:0.5">(estimat din VIX)</span>' : '';
    parts.push(`${ivStr}${skewStr}${estStr}.`);
  }

  return parts.join('<br>');
}


function setStatus(msg, type = 'info') {
  const el = $('status');
  el.textContent   = msg;
  el.className     = `status status--${type}`;
  el.style.display = msg ? 'block' : 'none';
}

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.section === id));
}

function fmt(n, dec = 2) {
  return n == null ? '—' : n.toLocaleString('en-US', {
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  });
}

// ── Sector + VIX badge ───────────────────────────────
function renderSectorBadge(sector, industry, vixData, weights) {
  const el = $('sector-badge');
  if (!el) return;
  const emoji    = weights?.emoji || '📊';
  const vixColor = !vixData?.vix    ? '#888'
                 : vixData.vix < 15 ? '#66bb6a'
                 : vixData.vix < 25 ? '#ffee58'
                 : vixData.vix < 35 ? '#ffa726'
                 : '#ef5350';

  const vixImpactDesc = !vixData?.vix
    ? 'Date VIX indisponibile.'
    : vixData.vix < 15
      ? 'Piata <strong style="color:#66bb6a">calma</strong> — sigma neschimbata in simulare.'
      : vixData.vix < 25
        ? 'Volatilitate <strong style="color:#ffee58">normala</strong> — impact redus asupra sigmei.'
        : vixData.vix < 35
          ? 'Volatilitate <strong style="color:#ffa726">ridicata</strong> — sigma creste +20% in simulare.'
          : 'Piata in <strong style="color:#ef5350">panica</strong> — sigma creste +40% in simulare.';

  el.innerHTML = `
    <span class="tip-wrap">
      <span class="sector-chip">${emoji} ${sector}</span>
      <i class="tip-icon" style="border-color:rgba(79,195,247,0.4)">i</i>
      <div class="tip-bubble">
        <strong>🏭 Sector — ${sector}</strong>
        ${industry ? `<em style="color:#aaa;font-size:10px">${industry}</em><br><br>` : ''}
        Sectorul determina <b>ponderile</b> celor 7 factori de sentiment. Fiecare sector amplifica factorii cei mai relevanti:
        <div class="tip-scale" style="margin-top:6px">
          <div class="tip-scale-row"><span class="tip-dot" style="background:#4fc3f7"></span> Energy → geopolitica + tarife</div>
          <div class="tip-scale-row"><span class="tip-dot" style="background:#ce93d8"></span> Technology → reglementari + inovatie</div>
          <div class="tip-scale-row"><span class="tip-dot" style="background:#ffcc02"></span> Financial → macro + dobânzi</div>
        </div>
        <span class="tip-impact">Influenteaza: ponderile sentimentului AI</span>
      </div>
    </span>
    <span class="tip-wrap">
      <span class="vix-chip" style="color:${vixColor}">
        VIX: ${vixData?.vix ?? 'N/A'} ${vixData?.vixLabel ?? ''}
      </span>
      <i class="tip-icon" style="border-color:${vixColor};color:${vixColor};background:transparent">i</i>
      <div class="tip-bubble">
        <strong>😱 VIX — Indicele fricii pietei</strong>
        Masoara volatilitatea <em>implicita</em> asteptata de piata pe urmatoarele 30 de zile. Cu cat e mai mare, cu atat piata anticipeaza miscari bruste.
        <div class="tip-scale" style="margin-top:6px">
          <div class="tip-scale-row"><span class="tip-dot" style="background:#66bb6a"></span> &lt; 15 — piata calma, sigma normala</div>
          <div class="tip-scale-row"><span class="tip-dot" style="background:#ffee58"></span> 15–25 — normal, impact minor</div>
          <div class="tip-scale-row"><span class="tip-dot" style="background:#ffa726"></span> 25–35 — ingrijorare, sigma +20%</div>
          <div class="tip-scale-row"><span class="tip-dot" style="background:#ef5350"></span> &gt; 35 — panica, sigma +40%</div>
        </div>
        <div style="margin-top:6px;font-size:10.5px">${vixImpactDesc}</div>
        <span class="tip-impact">Influenteaza: sigma in simulare</span>
      </div>
    </span>
  `;
  el.style.display = 'flex';
}

function renderStatsCard(stats, statsAdj, currentPrice, days, currency) {
  const sym = currency === 'USD' ? '$' : currency + ' ';
  function row(label, valC, valA, color) {
    return `<tr>
      <td class="stat-label">${label}</td>
      <td class="stat-val" style="color:${color||'#fff'}">${sym}${fmt(valC)}</td>
      ${valA != null ? `<td class="stat-val ai-col">${sym}${fmt(valA)}</td>` : `<td class="stat-val ai-col">—</td>`}
    </tr>`;
  }
  function pctRow(label, valC, valA, color) {
    return `<tr>
      <td class="stat-label">${label}</td>
      <td class="stat-val" style="color:${color||'#fff'}">${fmt(valC, 1)}%</td>
      ${valA != null ? `<td class="stat-val ai-col">${fmt(valA, 1)}%</td>` : `<td class="stat-val ai-col">—</td>`}
    </tr>`;
  }
  return `
    <div class="stats-card">
      <div class="stats-title">Statistici — ${days} zile</div>
      <table class="stats-table">
        <thead><tr><th></th><th style="color:#4fc3f7">Clasic</th><th style="color:#ffa726">AI Ajustat</th></tr></thead>
        <tbody>
          <tr><td colspan="3" class="stat-sep">Preturi estimate</td></tr>
          ${row('Pret curent',    currentPrice, null,            '#fff')}
          ${row('Medie',          stats.mean,   statsAdj?.mean,  '#ffee58')}
          ${row('Median',         stats.median, statsAdj?.median,'#fff')}
          ${row('P90 — optimist', stats.p90,    statsAdj?.p90,   '#66bb6a')}
          ${row('P10 — pesimist', stats.p10,    statsAdj?.p10,   '#ef5350')}
          ${row('Max simulat',    stats.max,    statsAdj?.max,   '#4fc3f7')}
          ${row('Min simulat',    stats.min,    statsAdj?.min,   '#4fc3f7')}
          <tr><td colspan="3" class="stat-sep">Probabilitati</td></tr>
          ${pctRow('Prob. profit',     stats.probProfit, statsAdj?.probProfit, '#66bb6a')}
          ${pctRow('Prob. gain > 10%', stats.probGain10, statsAdj?.probGain10, '#66bb6a')}
          ${pctRow('Prob. loss > 10%', stats.probLoss10, statsAdj?.probLoss10, '#ef5350')}
        </tbody>
      </table>
      <div class="stats-footer">${NUM_SIMS.toLocaleString()} simulari GBM</div>
    </div>`;
}

function renderPeriod(periodData, tab) {
  const { stats, statsAdj, percs, percsAdj, days, currentPrice, currency, ticker } = periodData;
  const canvasTraj = `traj-${tab}`;
  const canvasHist = `hist-${tab}`;
  $('chart-area').innerHTML = `
    <div class="chart-grid">
      <div class="chart-box">
        <div class="chart-label">Traiectorii simulate — ${days} zile</div>
        <div class="canvas-wrap"><canvas id="${canvasTraj}"></canvas></div>
      </div>
      <div class="chart-box">
        <div class="chart-label">Distributia preturilor finale — ${days} zile</div>
        <div class="canvas-wrap"><canvas id="${canvasHist}"></canvas></div>
      </div>
    </div>
    ${renderStatsCard(stats, statsAdj, currentPrice, days, currency)}
  `;
  requestAnimationFrame(() => {
    drawTrajectories(canvasTraj, percs, percsAdj, days, currentPrice, ticker);
    drawHistogram(canvasHist, stats, statsAdj, currentPrice, days);
  });
}

// ── Valuare Fundamentala — 4 metode ──────────────────
const VAL_SECTOR_WEIGHTS = {
  tutun:        { eps: 0.30, fcf: 0.30, nav: 0.10, dcf: 0.30 },
  energy:       { eps: 0.15, fcf: 0.35, nav: 0.10, dcf: 0.40 },
  utilitati:    { eps: 0.20, fcf: 0.25, nav: 0.15, dcf: 0.40 },
  asigurari:    { eps: 0.35, fcf: 0.20, nav: 0.30, dcf: 0.15 },
  conglomerate: { eps: 0.25, fcf: 0.25, nav: 0.20, dcf: 0.30 },
  consum:       { eps: 0.25, fcf: 0.25, nav: 0.15, dcf: 0.35 },
  tech:         { eps: 0.20, fcf: 0.15, nav: 0.10, dcf: 0.55 },
  reit:         { eps: 0.10, fcf: 0.35, nav: 0.40, dcf: 0.15 },
  shipping:     { eps: 0.20, fcf: 0.35, nav: 0.15, dcf: 0.30 },
};

// Yahoo Finance → sector key
const YAHOO_TO_VAL_SECTOR = {
  'Technology':             'tech',
  'Communication Services': 'tech',
  'Energy':                 'energy',
  'Utilities':              'utilitati',
  'Financial Services':     'asigurari',
  'Insurance':              'asigurari',
  'Real Estate':            'reit',
  'Industrials':            'conglomerate',
  'Healthcare':             'conglomerate',
  'Basic Materials':        'conglomerate',
  'Consumer Defensive':     'consum',
  'Consumer Cyclical':      'consum',
};

function calcValuare({ eps, pe, fcf, growth, wacc, tgr, assets, cash, debt, shares, sector }) {
  const w = VAL_SECTOR_WEIGHTS[sector] || VAL_SECTOR_WEIGHTS.tech;

  // Val EPS = EPS × P/E_corect
  const valEPS = (eps > 0 && pe > 0) ? eps * pe : null;

  // Val FCF = FCF/share × P/E_corect
  const valFCF = (fcf > 0 && pe > 0) ? fcf * pe : null;

  // NAV = (Active + Cash − Datorii) / Actiuni_M  → valoare per actiune
  const valNAV = (assets != null && cash != null && debt != null && shares > 0)
    ? (assets + cash - debt) / shares
    : null;

  // DCF: 10 ani FCF actualizat + valoare terminala Gordon Growth
  let valDCF = null;
  if (fcf > 0 && growth != null && wacc != null && tgr != null && wacc > tgr) {
    const g = growth / 100;
    const r = wacc   / 100;
    const t = tgr    / 100;
    let dcfSum = 0;
    for (let n = 1; n <= 10; n++) {
      dcfSum += (fcf * Math.pow(1 + g, n)) / Math.pow(1 + r, n);
    }
    const fcf10     = fcf * Math.pow(1 + g, 10);
    const terminalPV = (fcf10 * (1 + t) / (r - t)) / Math.pow(1 + r, 10);
    valDCF = dcfSum + terminalPV;
  }

  // Medie ponderata — renormalizeaza daca unele metode sunt N/A
  const methods = [
    { val: valEPS, w: w.eps },
    { val: valFCF, w: w.fcf },
    { val: valNAV, w: w.nav },
    { val: valDCF, w: w.dcf },
  ];
  const avail = methods.filter(m => m.val != null && isFinite(m.val));
  let weighted = null;
  if (avail.length > 0) {
    const totalW = avail.reduce((s, m) => s + m.w, 0);
    weighted = avail.reduce((s, m) => s + m.val * m.w / totalW, 0);
  }

  return { valEPS, valFCF, valNAV, valDCF, weighted, w };
}

function updateValuare() {
  const getNum = id => {
    const v = parseFloat($(`val-${id}`)?.value);
    return isNaN(v) ? null : v;
  };
  const sector    = $('val-sector')?.value || 'tech';
  const priceEl   = $('val-current-price');
  const curPrice  = priceEl ? parseFloat(priceEl.dataset.price)    : 0;
  const currency  = priceEl ? (priceEl.dataset.currency || 'USD')  : 'USD';
  const sym       = currency === 'USD' ? '$' : currency + ' ';

  const result = calcValuare({
    eps:    getNum('eps'),
    pe:     getNum('pe'),
    fcf:    getNum('fcf'),
    growth: getNum('growth'),
    wacc:   getNum('wacc'),
    tgr:    getNum('tgr'),
    assets: getNum('assets'),
    cash:   getNum('cash'),
    debt:   getNum('debt'),
    shares: getNum('shares'),
    sector,
  });
  const { valEPS, valFCF, valNAV, valDCF, weighted, w } = result;

  function fv(v) { return v != null ? `${sym}${v.toFixed(2)}` : '—'; }

  // Marja de siguranta
  let marginHtml = '';
  if (weighted != null && curPrice > 0) {
    const margin = (weighted - curPrice) / curPrice * 100;
    const color  = margin > 20 ? '#66bb6a' : margin > 0 ? '#ffee58' : '#ef5350';
    const label  = margin > 20 ? '✔ Subapreciat' : margin > 0 ? '≈ Corect evaluat' : '✘ Supraevaluat';
    marginHtml = `
      <div class="val-margin-card"
           style="background:${color}18;border:1px solid ${color}44;">
        <div class="vm-label" style="color:${color}99;">Marja siguranta</div>
        <div class="vm-val"   style="color:${color};">${margin >= 0 ? '+' : ''}${margin.toFixed(1)}%</div>
        <div class="vm-weight" style="color:${color}77;">${label}</div>
      </div>`;
  }

  const grid = $('val-results-grid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="val-method-card">
      <div class="vm-label">Val. PE</div>
      <div class="vm-val">${fv(valEPS)}</div>
      <div class="vm-weight">Pondere ${(w.eps * 100).toFixed(0)}%</div>
    </div>
    <div class="val-method-card">
      <div class="vm-label">Val. FCF</div>
      <div class="vm-val">${fv(valFCF)}</div>
      <div class="vm-weight">Pondere ${(w.fcf * 100).toFixed(0)}%</div>
    </div>
    <div class="val-method-card">
      <div class="vm-label">Val. NAV</div>
      <div class="vm-val">${fv(valNAV)}</div>
      <div class="vm-weight">Pondere ${(w.nav * 100).toFixed(0)}%</div>
    </div>
    <div class="val-method-card">
      <div class="vm-label">Val. DCF</div>
      <div class="vm-val">${fv(valDCF)}</div>
      <div class="vm-weight">Pondere ${(w.dcf * 100).toFixed(0)}%</div>
    </div>
    <div class="val-weighted-card">
      <div class="vm-label">Val. Medie Ponderată</div>
      <div class="vm-val">${fv(weighted)}</div>
      <div class="vm-weight">Preț curent: ${sym}${curPrice > 0 ? curPrice.toFixed(2) : '—'}</div>
    </div>
    ${marginHtml}`;
}

window.toggleValuare = function() {
  const content = $('val-content');
  const icon    = $('val-toggle-icon');
  if (!content || !icon) return;
  const isOpen = content.style.display !== 'none';
  content.style.display = isOpen ? 'none' : 'block';
  icon.textContent = isOpen ? '▼ Extinde' : '▲ Restrânge';
};

// ── Fetch date fundamentale — replicare yfinance ──────
// yfinance foloseste: 1) cookie de sesiune de pe fc.yahoo.com
//                     2) crumb de pe query2/v1/test/getcrumb
//                     3) quoteSummary cu crumb-ul obtinut
// Replicam acest flux prin proxy-uri care fac fetch server-side.

async function _yGet(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal:  ctrl.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  } finally { clearTimeout(tid); }
}

// Proxies care fac fetch server-side (mentin sesiunea pe serverul lor)
const _YPX = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

// ── Fetch robustez: direct + fallback proxy ───────────
async function _robustGet(url, ms = 10000) {
  // Incearca direct (pentru SEC data.sec.gov care are CORS nativ)
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(tid);
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        return ct.includes('json') ? r.json() : r.text();
      }
    } finally { clearTimeout(tid); }
  } catch (_) {}
  // Fallback prin proxy (pentru www.sec.gov care poate bloca CORS)
  for (const px of _YPX) {
    try {
      const j = await _yGet(px(url), Math.min(ms, 8000));
      if (j != null) return j;
    } catch (_) {}
  }
  throw new Error(`Fetch esuat: ${url.split('/').slice(-1)[0]}`);
}

// ── SEC EDGAR — date bilant din rapoarte 10-K ─────────
let _secTickerCache = null;

async function _secCIK(ticker) {
  const clean = ticker.split('.')[0].split('-')[0].toUpperCase();

  // Cache localStorage (valabil 24h)
  if (!_secTickerCache) {
    try {
      const s = localStorage.getItem('_sec_tk');
      if (s) {
        const { ts, d } = JSON.parse(s);
        if (Date.now() - ts < 86_400_000) _secTickerCache = d;
      }
    } catch (_) {}
  }
  if (!_secTickerCache) {
    // www.sec.gov nu are CORS → folosim proxy
    const raw = await _robustGet('https://www.sec.gov/files/company_tickers.json', 18000);
    _secTickerCache = raw;
    try { localStorage.setItem('_sec_tk', JSON.stringify({ ts: Date.now(), d: raw })); } catch (_) {}
  }

  const entry = Object.values(_secTickerCache).find(c => c.ticker?.toUpperCase() === clean);
  return entry ? String(entry.cik_str).padStart(10, '0') : null;
}

function _secLatest(json, unit = 'USD') {
  const arr = json?.units?.[unit];
  if (!arr) return null;
  // 10-K = US domestic annual | 20-F = foreign private issuer annual (IFRS)
  return arr
    .filter(d => d.val != null && /^(10-K|20-F)/.test(d.form))
    .sort((a, b) => new Date(b.end) - new Date(a.end))[0]?.val ?? null;
}

async function _fetchSEC(ticker) {
  const cik = await _secCIK(ticker);
  if (!cik) throw new Error(`${ticker} nu e in SEC`);

  // Incearca us-gaap, then alt-name in us-gaap, then ifrs-full
  // (ENB, EQNR = IFRS + 20-F; MO, PM, MSFT = US GAAP + 10-K)
  async function getConcept(name, altName, unit = 'USD') {
    const urls = [
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${name}.json`,
      altName && `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${altName}.json`,
      `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/ifrs-full/${name}.json`,
    ].filter(Boolean);

    for (const url of urls) {
      try {
        const json = await _robustGet(url, 8000);
        const val  = _secLatest(json, unit);
        if (val != null) return val;
      } catch (_) {}
    }
    return null;
  }

  const [assets, cash, debt, opCF, capex, sharesN] = await Promise.all([
    getConcept('Assets', null),
    getConcept('CashAndCashEquivalentsAtCarryingValue', 'CashAndCashEquivalents'),
    getConcept('LongTermDebt', 'LongTermDebtNoncurrent'),
    getConcept('NetCashProvidedByUsedInOperatingActivities', 'CashFlowsFromUsedInOperatingActivities'),
    getConcept('PaymentsToAcquirePropertyPlantAndEquipment',
               'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'),
    getConcept('CommonStockSharesOutstanding', null, 'shares'),
  ]);

  const fcf = opCF != null ? opCF - (capex ?? 0) : null;
  return {
    totalAssets: assets  != null ? assets  / 1e6 : null,
    cash:        cash    != null ? cash    / 1e6 : null,
    debt:        debt    != null ? debt    / 1e6 : null,
    shares:      sharesN != null ? sharesN / 1e6 : null,
    fcfPerShare: (fcf != null && sharesN > 0) ? fcf / sharesN : null,
  };
}

// ── Yahoo v7/quote — EPS + growth (fara crumb, prin proxy) ──
async function _fetchYahooQuote(ticker) {
  const urls = [
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&formatted=false`,
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&formatted=false`,
    `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${ticker}`,
    `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${ticker}`,
  ];
  for (const url of urls) {
    for (const px of _YPX) {
      try {
        const json = await _yGet(px(url), 7000);
        if (typeof json !== 'object') continue;
        const q = json?.quoteResponse?.result?.[0] ?? json?.quoteSummary?.result?.[0];
        if (!q) continue;
        return {
          eps:    q.epsTrailingTwelveMonths ?? q.trailingEps ?? null,
          growth: q.earningsGrowth != null ? q.earningsGrowth * 100
                : q.revenueGrowth  != null ? q.revenueGrowth  * 100 : null,
          shares: q.sharesOutstanding != null ? q.sharesOutstanding / 1e6 : null,
        };
      } catch (_) {}
    }
  }
  return {};
}

async function fetchValuationFundamentals(ticker) {
  const isUS = !ticker.includes('.') && !ticker.includes('-');

  const tasks = isUS
    ? [_fetchSEC(ticker), _fetchYahooQuote(ticker)]
    : [Promise.resolve({}), _fetchYahooQuote(ticker)];

  const [secR, quoteR] = await Promise.allSettled(tasks);
  const sec   = secR.status   === 'fulfilled' ? secR.value   : {};
  const quote = quoteR.status === 'fulfilled' ? quoteR.value : {};

  const result = {
    eps:         quote.eps                  ?? null,
    growth:      quote.growth               ?? null,
    shares:      sec.shares   ?? quote.shares ?? null,
    fcfPerShare: sec.fcfPerShare            ?? null,
    totalAssets: sec.totalAssets            ?? null,
    cash:        sec.cash                   ?? null,
    debt:        sec.debt                   ?? null,
  };

  if (Object.values(result).every(v => v == null)) {
    throw new Error('Date indisponibile');
  }
  return result;
}

function setValInput(id, value, decimals = 2) {
  const el = $(`val-${id}`);
  if (!el || value == null || !isFinite(value)) return;
  el.value = parseFloat(value.toFixed(decimals));
  // Flash vizual — bordura scurta verde ca sa se vada ca a venit din API
  el.style.borderColor = 'rgba(102,187,106,0.7)';
  setTimeout(() => { el.style.borderColor = ''; }, 1200);
}

function initValuarePanel(currentPrice, currency, yahooSector, ticker, metaFundamentals = {}) {
  const panel = $('valuation-panel');
  if (!panel) return;

  // Stocheaza pretul curent pentru calcul marja
  let priceEl = $('val-current-price');
  if (!priceEl) {
    priceEl = document.createElement('span');
    priceEl.id = 'val-current-price';
    priceEl.style.display = 'none';
    panel.appendChild(priceEl);
  }
  priceEl.dataset.price    = currentPrice;
  priceEl.dataset.currency = currency || 'USD';

  // Auto-selecteaza sectorul din Yahoo Finance
  if (yahooSector && YAHOO_TO_VAL_SECTOR[yahooSector]) {
    const sel = $('val-sector');
    if (sel) sel.value = YAHOO_TO_VAL_SECTOR[yahooSector];
  }

  // Ataseaza listeners o singura data
  if (!panel.dataset.listenersAttached) {
    ['sector','eps','pe','fcf','growth','wacc','tgr','assets','cash','debt','shares'].forEach(id => {
      const el = $(`val-${id}`);
      el?.addEventListener('input',  updateValuare);
      el?.addEventListener('change', updateValuare);
    });
    panel.dataset.listenersAttached = '1';
  }

  panel.style.display = 'block';

  // ── Pas 1: populare imediata din meta chart (acelasi apel deja reusit) ──
  const statusEl = ensureValStatus();
  let metaPopulated = 0;
  if (metaFundamentals.eps    != null) { setValInput('eps',    metaFundamentals.eps,    2); metaPopulated++; }
  if (metaFundamentals.shares != null) { setValInput('shares', metaFundamentals.shares, 0); metaPopulated++; }

  if (metaPopulated > 0) {
    statusEl.textContent = `✔ EPS + acțiuni din chart API · se descarcă FCF, cash, datorii...`;
    statusEl.style.color = 'rgba(102,187,106,0.55)';
  } else {
    statusEl.textContent = '⏳ Se descarcă date fundamentale...';
    statusEl.style.color = 'rgba(255,255,255,0.4)';
  }
  updateValuare();

  // ── Pas 2: quoteSummary async pentru restul campurilor ──
  if (!ticker) return;
  fetchValuationFundamentals(ticker).then(d => {
    // Suprascrie EPS/shares doar daca meta nu le-a dat
    if (metaFundamentals.eps    == null) setValInput('eps',    d.eps,    2);
    if (metaFundamentals.shares == null) setValInput('shares', d.shares, 0);
    setValInput('fcf',    d.fcfPerShare, 2);
    setValInput('assets', d.totalAssets, 0);
    setValInput('cash',   d.cash,        0);
    setValInput('debt',   d.debt,        0);
    setValInput('growth', d.growth,      1);
    statusEl.textContent = '✔ Date Yahoo Finance · P/E corect, WACC, rata terminală — completează manual';
    statusEl.style.color = 'rgba(102,187,106,0.65)';
    updateValuare();
  }).catch(err => {
    const msg = metaPopulated > 0
      ? '⚠ FCF/cash/datorii indisponibile — completează manual'
      : '⚠ Date fundamentale indisponibile — completează manual';
    statusEl.textContent = msg;
    statusEl.style.color = 'rgba(255,167,38,0.6)';
    console.warn('Val fetch error:', err);
  });
}

function ensureValStatus() {
  let el = $('val-fetch-status');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'val-fetch-status';
  el.style.cssText = 'font-size:10px;margin-top:6px;letter-spacing:0.3px;';
  const header = document.querySelector('#valuation-panel .val-header');
  if (header) header.after(el);
  else $('valuation-panel')?.appendChild(el);
  return el;
}

// ── Simulare principala ───────────────────────────────
async function runSimulation() {
  const ticker      = $('ticker-input').value.trim().toUpperCase();
  const doSentiment = $('toggle-sentiment').checked;
  if (!ticker) { setStatus('Introdu un ticker.', 'error'); return; }

  destroyAll();
  $('results-section').style.display   = 'none';
  $('sentiment-section').style.display = 'none';
  const sectorBadgeEl = $('sector-badge');
  if (sectorBadgeEl) sectorBadgeEl.style.display = 'none';
  const valPanel = $('valuation-panel');
  if (valPanel) {
    valPanel.style.display = 'none';
    // Sterge valorile din simularea anterioara (fetch nou la rulare)
    ['eps','fcf','shares','assets','cash','debt'].forEach(id => {
      const el = $(`val-${id}`);
      if (el) el.value = '';
    });
    const statusEl = $('val-fetch-status');
    if (statusEl) statusEl.textContent = '';
  }
  $('run-btn').disabled    = true;
  $('run-btn').textContent = 'Se ruleaza...';

  try {
    // ── 1. Date istorice ─────────────────────────────
    setStatus(`Descarc date pentru ${ticker}...`);
    const stock = await fetchStockData(ticker);
    const { closes, dates, volumes, currentPrice, currency, name, fundamentals } = stock;
    $('stock-name').textContent   = name;
    $('stock-price').textContent  = `${currency} ${fmt(currentPrice)}`;
    $('stock-ticker').textContent = ticker;
    drawPriceHistory('price-chart', dates.slice(-60), closes.slice(-60), ticker);

    // ── 2. Parametri GBM + GARCH(1,1) ───────────────
    setStatus('Calculez parametri GBM + GARCH(1,1)...');
    const { drift, sigma, mean50, deviationPct, volumeTrend, garch, nu } = calcParams(closes, volumes);

    // ── Afiseaza pills individuale cu culori dinamice ──
    const sigmaStaticPct = (sigma * 100).toFixed(3);
    const volAnualPct    = sigma * Math.sqrt(252) * 100;

    // ① Sigma zilnica statica
    const sigmaColor = sigma < 0.01 ? 'green' : sigma < 0.02 ? 'yellow' : 'red';
    setPillColor('pill-sigma', sigmaColor);
    $('info-sigma').textContent = `${sigmaStaticPct}%/zi`;

    // ② GARCH actual
    if (garch) {
      const sigmaGarchPct = (garch.sigma0 * 100).toFixed(3);
      const garchRegime   = garch.sigma0 > garch.sigmaLR * 1.15 ? 'red'
                          : garch.sigma0 < garch.sigmaLR * 0.85 ? 'green' : 'yellow';
      const garchEmoji    = garchRegime === 'red' ? '🔴' : garchRegime === 'green' ? '🟢' : '🟡';
      setPillColor('pill-garch', garchRegime);
      $('info-garch').textContent = `${sigmaGarchPct}%/zi ${garchEmoji}`;

      // ⑤ Persistenta GARCH
      const persVal   = garch.persistence;
      const persColor = persVal < 0.85 ? 'green' : persVal < 0.95 ? 'yellow' : 'red';
      setPillColor('pill-pers', persColor);
      $('info-pers').textContent = `${(persVal * 100).toFixed(1)}%`;
    } else {
      setPillColor('pill-garch', 'gray');
      $('info-garch').textContent = 'N/A';
      setPillColor('pill-pers', 'gray');
      $('info-pers').textContent = 'N/A';
    }

    // ③ Student-t ν (fat tails)
    const nuColor = nu < 5 ? 'red' : nu < 8 ? 'orange' : nu < 20 ? 'yellow' : 'green';
    const nuLabel = nu >= 29 ? `ν=${nu} normal`
                  : nu >= 10 ? `ν=${nu} medii`
                  : nu >= 5  ? `ν=${nu} groase`
                  :            `ν=${nu} f.groase`;
    setPillColor('pill-nu', nuColor);
    $('info-nu').textContent = nuLabel;

    // ④ Volatilitate anuala
    const volColor = volAnualPct < 20 ? 'green' : volAnualPct < 40 ? 'yellow' : 'red';
    setPillColor('pill-vol', volColor);
    $('info-vol').textContent = `${volAnualPct.toFixed(1)}%/an`;

    // ⑥ Drift
    const driftColor = drift > 0.0001 ? 'green' : drift < -0.0001 ? 'red' : 'gray';
    setPillColor('pill-drift', driftColor);
    $('info-drift').textContent = `${drift >= 0 ? '+' : ''}${(drift * 100).toFixed(4)}%/zi`;

    // ⑦ MA60
    const absDev  = Math.abs(deviationPct);
    const maColor = absDev < 5 ? 'green' : absDev < 15 ? 'yellow' : 'red';
    setPillColor('pill-ma60', maColor);
    $('info-ma50').textContent = `${mean50 != null ? mean50.toFixed(2) : '—'} (${deviationPct >= 0 ? '+' : ''}${deviationPct.toFixed(1)}%)`;

    // ⑧ Vol trend
    const vtDetail = volumeTrend?.detail ?? '';
    const vtColor  = vtDetail === 'bullish' ? 'green'
                   : vtDetail === 'bearish' ? 'red'
                   : vtDetail.includes('bullish') ? 'yellow'
                   : vtDetail.includes('bearish') ? 'orange'
                   : 'gray';
    setPillColor('pill-voltren', vtColor);
    $('info-voltren').textContent = volumeTrend?.label ?? '—';

    // ── 2b. IV + Sector + VIX in paralel ────────────────
    // Toate trei sunt independente de IV — le lansam simultan
    setStatus('Caut IV, sector si VIX in paralel...');
    let ivData = null;
    let sectorWeights = null;
    let vixData       = { vix: null, vixLabel: 'N/A', vixImpact: 0 };
    {
      const [ivResult, sectorResult, vixResult] = await Promise.allSettled([
        fetchImpliedVolatility(ticker, currentPrice, msg => setStatus(msg)),
        fetchSectorData(ticker),
        fetchVIX(),
      ]);
      if (ivResult.status === 'fulfilled')     ivData        = ivResult.value;
      if (sectorResult.status === 'fulfilled') {
        sectorWeights = sectorResult.value.weights;
        // Badge-ul se randeaza dupa ce avem si VIX
      }
      if (vixResult.status === 'fulfilled')    vixData       = vixResult.value;
      if (sectorResult.status === 'fulfilled') {
        renderSectorBadge(sectorResult.value.sector, sectorResult.value.industry,
                          vixData, sectorResult.value.weights);
        initValuarePanel(currentPrice, currency, sectorResult.value.sector, ticker, fundamentals);
      } else {
        initValuarePanel(currentPrice, currency, null, ticker, fundamentals);
      }
    }

    // ── Fallback: IV estimat din VIX + sigma istorica ──
    // Folosit cand API-urile de optiuni nu raspund (EU/RO stocks, CORS, etc.)
    let ivEstimated = false;
    if (!ivData) {
      setStatus('IV: calculez estimat din VIX + caracteristici actiune...');
      try {
        const vixVal = vixData?.vix   // deja descarcat in paralel
          ?? (await Promise.race([fetchVIX(), new Promise(r => setTimeout(() => r(null), 4000))]))?.vix;
        if (vixVal && vixVal > 0) {
          const sigmaAnnual = sigma * Math.sqrt(252);
          const vixDaily    = (vixVal / 100) / Math.sqrt(252);

          // ── Factor 1: agresivitatea actiunii vs piata ──
          // sigmaVsMarket < 0.8 → actiune defensiva (VZ, KO, NEE)
          // sigmaVsMarket 1-2   → actiune normala (JPM, XOM)
          // sigmaVsMarket > 2.5 → actiune speculativa (NVDA, TSLA)
          const sigmaVsMarket = sigma / Math.max(vixDaily, 0.0001);
          const ivPremium = sigmaVsMarket < 0.8  ? 1.05   // defensive
                          : sigmaVsMarket < 1.2  ? 1.10   // aproape de piata
                          : sigmaVsMarket < 1.8  ? 1.15   // usor speculativ
                          : sigmaVsMarket < 2.5  ? 1.22   // speculativ
                          :                        1.32;  // foarte speculativ

          // ── Factor 2: persistenta GARCH ───────────────
          // Persistenta mare → vol cluster → piata anticipeaza volatilitate sustinuta
          const garchPersAdj = garch
            ? Math.max(0.85, Math.min(1.20, 1 + (garch.persistence - 0.85) * 0.6))
            : 1.0;

          // ── Factor 3: cozi distributiei (Student-t ν) ─
          // ν mic → cozi groase → tail risk premium in optiuni
          const tailAdj = nu < 5 ? 1.18 : nu < 8 ? 1.09 : nu < 15 ? 1.04 : 1.0;

          // ── IV estimat final ───────────────────────────
          const ivEstAnnual = sigmaAnnual * (vixVal / 20) * ivPremium * garchPersAdj * tailAdj;
          const ivEstDaily  = ivEstAnnual / Math.sqrt(252);

          // ── Skew estimat specific actiunii ────────────
          // Actiuni mai volatile = mai mult fear premium pe puts → skew mai mare
          // VIX=15→baza 0%, VIX=20→1.8%, VIX=30→9% scalat cu agresivitatea
          const baseSkew  = Math.max(0, (vixVal - 15) * 0.006);
          const skewAdj   = Math.min(2.0, Math.max(0.4, sigmaVsMarket * 0.75));
          const skewEst   = baseSkew * skewAdj;

          ivData = {
            ivAnnual: ivEstAnnual, ivDaily: ivEstDaily,
            atmStrike: null, daysToExp: 30,
            skewData: { skew: skewEst, putIV: null, callIV: null,
                        putStrike: null, callStrike: null },
          };
          ivEstimated = true;
        }
      } catch (_) {}
    }

    if (ivData) {
      const ivAnnPct = (ivData.ivAnnual * 100).toFixed(1);
      const ivRatio  = ivData.ivDaily / sigma;
      const ivColor  = ivRatio < 0.85 ? 'green' : ivRatio < 1.20 ? 'yellow' : 'red';
      setPillColor('pill-iv', ivColor);
      $('info-iv').textContent = ivEstimated
        ? `~${ivAnnPct}%/an est.`
        : `${ivAnnPct}%/an · ${ivData.daysToExp}z`;
    } else {
      setPillColor('pill-iv', 'gray');
      $('info-iv').textContent = 'N/A';
    }

    // ── Put/Call Skew → ajustare drift ───────────────
    let skewDriftAdj = 0;
    if (ivData?.skewData) {
      const { skew } = ivData.skewData;
      const NEUTRAL_SKEW = 0.07;
      const sigmaAnnual  = sigma * Math.sqrt(252);
      const normalizedSkew = (skew - NEUTRAL_SKEW) / Math.max(sigmaAnnual, 0.15);
      skewDriftAdj = -Math.tanh(normalizedSkew * 1.5) * 0.00025;

      const skewPct   = (skew * 100).toFixed(1);
      const skewColor = skew < 0 ? 'green' : skew < 0.08 ? 'yellow' : skew < 0.15 ? 'orange' : 'red';
      const skewSign  = skew >= 0 ? '+' : '';
      setPillColor('pill-skew', skewColor);
      $('info-skew').textContent = ivEstimated
        ? `~${skewSign}${skewPct}% est.`
        : `${skewSign}${skewPct}%`;
    } else {
      setPillColor('pill-skew', 'gray');
      $('info-skew').textContent = 'N/A';
    }

    // ── Comentariu calitativ ─────────────────────────────
    const qComment = generateQualityComment({
      sigma, volAnualPct, nu, garch, drift, deviationPct, volumeTrend,
      ivData, ivEstimated,
    });
    const qEl = $('quality-comment');
    if (qEl) {
      qEl.innerHTML  = qComment;
      qEl.style.display = 'block';
    }

    // Raport de ajustare pentru sigmaAdj (calculat mai tarziu, dupa sentiment)
    let sigmaAdjRatio = null;

    // ── 4. Sentiment AI ──────────────────────────────
    let sentimentData = null;
    let driftAdj = null, sigmaAdj = null, meanRevStrength = 0;

    if (doSentiment) {
      setStatus('Analizez sentiment (Yahoo + Reuters + Google News)...');
      try {
        sentimentData = await analyzeSentiment(ticker, name, msg => setStatus(msg));
        if (sentimentData.sectorWeights) sectorWeights = sentimentData.sectorWeights;
        if (sentimentData.vix?.vix)      vixData       = sentimentData.vix;

        const scores = Object.values(sentimentData.factori).map(f => f.scor);
        const adj    = adjustParams(drift, sigma, scores, sectorWeights, vixData.vixImpact, deviationPct, volumeTrend?.score ?? 0);
        driftAdj        = adj.driftAdj;
        sigmaAdj        = adj.sigmaAdj;
        meanRevStrength = adj.meanRevStrength ?? 0;
        if (sigmaAdj != null && sigma > 0) sigmaAdjRatio = sigmaAdj / sigma;

        $('sent-global').textContent = `${sentimentData.sentimentGlobal >= 0 ? '+' : ''}${sentimentData.sentimentGlobal.toFixed(3)}`;
        $('sent-global').style.color = sentimentData.sentimentGlobal > 0.1 ? '#66bb6a'
                                     : sentimentData.sentimentGlobal < -0.1 ? '#ef5350' : '#ffee58';
        $('sent-conclusion').textContent = sentimentData.concluzie;
        {
          const s  = sentimentData.surse;
          const ts = sentimentData.tierStats;
          const brut = s.yahoo + s.reuters + s.google + s.seekingAlpha + s.euronews;
          $('sent-sources').textContent =
            `Yahoo: ${s.yahoo} | AP/CNBC: ${s.reuters} | Google: ${s.google} | SA: ${s.seekingAlpha} | EN: ${s.euronews}` +
            `  ·  ${brut} brut → ${sentimentData.totalBrut} unice` +
            `  ·  Filtrat: T1:${ts.t1} T2:${ts.t2} T3:${ts.t3} zgomot:${ts.t4}` +
            `  →  ${sentimentData.totalStiri} stiri folosite in calcul`;
        }

        drawSentiment('sentiment-chart', sentimentData);
        $('sentiment-section').style.display = 'block';

        const detailsHtml = Object.entries(sentimentData.factori).map(([key, f]) => `
          <div class="factor-card ${f.impact}">
            <div class="factor-header">
              <span class="factor-label">${f.label}</span>
              <span class="factor-score">${f.scor >= 0 ? '+' : ''}${f.scor.toFixed(3)}</span>
              <span class="factor-impact impact-${f.impact}">${f.impact.toUpperCase()}</span>
              <span style="font-size:10px;color:#888;margin-left:4px">pond. ${f.weight}x</span>
            </div>
            <div class="factor-count">${f.count} stiri analizate</div>
            ${f.stiri.slice(0, 3).map(s =>
              `<div class="factor-news" style="color:${s.score>0.05?'#a5d6a7':s.score<-0.05?'#ef9a9a':'#888'}">
                 ${s.sursa}: ${s.titlu.slice(0, 90)}${s.titlu.length > 90 ? '...' : ''}
               </div>`
            ).join('')}
          </div>`).join('');
        $('factors-detail').innerHTML = detailsHtml;

      } catch (e) {
        console.warn('Sentiment error:', e);
        setStatus('Sentiment indisponibil — continuam fara.', 'warn');
      }
    }

    // ── 5. Monte Carlo ───────────────────────────────
    const PERIODS = [30, 90, 180, 360];
    // step per perioadă: 30d→1 (exact), 90d→2, 180d→3, 360d→5
    // Reduce sorturi: 211 in loc de 664 — fara diferenta vizuala
    const PERC_STEP = { 30: 1, 90: 2, 180: 3, 360: 5 };
    const periodResults = {};
    for (const days of PERIODS) {
      setStatus(`Simulez ${days} zile (${NUM_SIMS.toLocaleString()} scenarii)...`);
      await new Promise(r => setTimeout(r, 0));

      // Sigma blended: IV (forward-looking) + istorica, ponderate dupa orizont
      // 30z: 70% IV | 90z: 33% IV | 180z: 17% IV | 360z: 10% IV
      const sigmaBlended    = blendSigma(sigma, ivData?.ivDaily, days);
      const sigmaAdjBlended = sigmaAdjRatio != null ? sigmaBlended * sigmaAdjRatio : null;

      // Skew drift aplicat uniform pe ambele simulari (semnal de piata, independent de sentiment)
      const driftSkewed    = drift    + skewDriftAdj;
      const driftAdjSkewed = driftAdj != null ? driftAdj + skewDriftAdj : null;

      const step      = PERC_STEP[days];
      const matrix    = simulate(currentPrice, driftSkewed, sigmaBlended, days, null, null, meanRevStrength, mean50, garch, nu);
      const matrixAdj = driftAdjSkewed != null
        ? simulate(currentPrice, driftSkewed, sigmaBlended, days, driftAdjSkewed, sigmaAdjBlended, meanRevStrength, mean50, garch, nu) : null;
      periodResults[days] = {
        days,
        stats:    calcStats(matrix, days, currentPrice),
        statsAdj: matrixAdj ? calcStats(matrixAdj, days, currentPrice) : null,
        percs:    percentilesPerDay(matrix, days, [10, 50, 90], step),
        percsAdj: matrixAdj ? percentilesPerDay(matrixAdj, days, [10, 50, 90], step) : null,
        currentPrice, currency, ticker,
      };
    }

    currentResult = { stock, periodResults, sentimentData, drift, sigma, driftAdj, sigmaAdj, garch, nu };

    // ── 6. Salveaza istoric ──────────────────────────
    saveIstoric(ticker, `${currency} ${fmt(currentPrice)}`);
    renderIstoric();

    // ── Buton Adauga la urmarit ──────────────────────
    const saveBtn = $('save-watchlist-btn');
    if (saveBtn) {
      saveBtn.style.display = 'inline-block';
      saveBtn.textContent   = '📌 Adaugă la urmărit';
      saveBtn.onclick = async () => {
        saveBtn.textContent = '⏳ Se captează graficele...';
        saveBtn.disabled    = true;

        try {
          // Captureaza graficele tuturor perioadelor
          const charts = await captureChartsForWatchlist(periodResults, currentPrice, ticker);

          // Colecteaza valorile pills
          const pills = [];
          [['pill-sigma','info-sigma'],['pill-iv','info-iv'],['pill-skew','info-skew'],
           ['pill-garch','info-garch'],['pill-nu','info-nu'],['pill-vol','info-vol'],
           ['pill-pers','info-pers'],['pill-drift','info-drift'],
           ['pill-ma60','info-ma50'],['pill-voltren','info-voltren'],
          ].forEach(([pid, vid]) => {
            const label = document.querySelector(`#${pid} .tip-wrap`)?.childNodes[0]?.textContent?.trim() || pid;
            const val   = $(vid)?.textContent || '—';
            pills.push(`${label} ${val}`);
          });

          const now   = new Date();
          const entry = {
            ticker,
            name:     name || ticker,
            price:    fmt(currentPrice),
            currency,
            date:     now.toLocaleDateString('ro-RO', { day:'2-digit', month:'short', year:'numeric' }),
            time:     now.toLocaleTimeString('ro-RO', { hour:'2-digit', minute:'2-digit' }),
            pills,
            comment:  $('quality-comment')?.innerHTML || '',
            charts,
          };

          saveToWatchlist(entry);
          renderWatchlist();
          saveBtn.textContent = '✓ Salvat!';
          setTimeout(() => { saveBtn.textContent = '📌 Adaugă la urmărit'; }, 2500);
        } catch (err) {
          console.error('Watchlist save error:', err);
          saveBtn.textContent = `⚠ ${err.message || 'Eroare'}`;
          setTimeout(() => { saveBtn.textContent = '📌 Adaugă la urmărit'; }, 3500);
        } finally {
          saveBtn.disabled = false;
        }
      };
    }

    // ── 7. Randare rezultate ─────────────────────────
    setStatus('');
    $('results-section').style.display = 'block';
    const tabsEl = $('period-tabs');
    tabsEl.innerHTML = '';
    PERIODS.forEach((days, i) => {
      const btn       = document.createElement('button');
      btn.className   = `tab-btn ${i === 0 ? 'active' : ''}`;
      btn.textContent = `${days} zile`;
      btn.onclick     = () => {
        tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        destroyPeriodCharts();
        renderPeriod(periodResults[days], days);
      };
      tabsEl.appendChild(btn);
    });
    renderPeriod(periodResults[30], 30);
    showSection('sim-section');

  } catch (err) {
    setStatus(`Eroare: ${err.message}`, 'error');
    console.error(err);
  } finally {
    $('run-btn').disabled    = false;
    $('run-btn').textContent = 'Ruleaza simularea';
  }
}

// ── Event listeners ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderIstoric();
  renderWatchlist();
  $('run-btn').addEventListener('click', runSimulation);
  $('ticker-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') runSimulation();
  });
  $('export-watchlist-btn')?.addEventListener('click', exportWatchlistHTML);
  $('import-watchlist-btn')?.addEventListener('click', () => {
    $('import-watchlist-input')?.click();
  });
  $('import-watchlist-input')?.addEventListener('change', e => {
    importWatchlistFiles(e.target.files);
    e.target.value = ''; // reset ca sa poata reimporta acelasi fisier
  });
  $('clear-watchlist-btn')?.addEventListener('click', () => {
    if (confirm('Ștergi toată lista de urmărit?')) {
      localStorage.removeItem(WATCHLIST_KEY);
      renderWatchlist();
    }
  });
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });
  document.querySelectorAll('.example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('ticker-input').value = chip.dataset.ticker;
    });
  });
});
