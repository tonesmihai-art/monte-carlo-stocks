// ─────────────────────────────────────────────────────
//  WATCHLIST.JS — UI watchlist: randare, export, import,
//                 lightbox grafice, drag-and-drop reordering
// ─────────────────────────────────────────────────────

import { $, showSection } from './ui.js';
import { loadWatchlist, saveToWatchlist, WATCHLIST_KEY } from './storage.js';

// ── Captureaza graficele pentru toate perioadele ──────

export async function captureChartsForWatchlist(periodResults, currentPrice, ticker) {
  const captures = {};

  const tmpDiv = document.createElement('div');
  tmpDiv.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'width:660px',
    'opacity:0.01', 'pointer-events:none',
    'z-index:99999', 'overflow:visible',
  ].join(';');
  document.body.appendChild(tmpDiv);

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

      const trajC = document.createElement('canvas');
      trajC.width = 370; trajC.height = 188;
      const histC = document.createElement('canvas');
      histC.width = 270; histC.height = 188;
      tmpDiv.appendChild(trajC);
      tmpDiv.appendChild(histC);

      let chartTraj = null, chartHist = null;
      try {
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
            animation: false, responsive: false, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#aaa', font: { size: 9 }, boxWidth: 12 } } },
            scales: {
              x: { ticks: { color: '#555577', maxTicksLimit: 6, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
              y: { ticks: { color: '#555577', callback: v => `$${v.toFixed(0)}`, font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            },
          },
        });

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
            animation: false, responsive: false, maintainAspectRatio: false,
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

      await new Promise(r => setTimeout(r, 60));

      const tj = toJpeg(trajC);
      const hj = toJpeg(histC);
      if (tj || hj) captures[days] = { traj: tj, hist: hj };

      try { chartTraj?.destroy(); } catch (_) {}
      try { chartHist?.destroy(); } catch (_) {}
    }
  } finally {
    try { document.body.removeChild(tmpDiv); } catch (_) {}
  }

  return captures;
}

// ── HTML grafice pentru un entry ─────────────────────

export function chartsHTML(e, forExport = false) {
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

// ── Lightbox ──────────────────────────────────────────

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

window.openWatchlistCharts = function (idx) {
  const list = loadWatchlist();
  const e    = list[idx];
  if (!e) return;
  const lb      = ensureLightbox();
  const content = $('wl-lb-content');
  const periods = [30, 90, 180, 360].filter(d => e.charts?.[d]);

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

// ── Randeaza lista watchlist ──────────────────────────

export function renderWatchlist() {
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
                border-radius:10px;padding:14px 16px;transition:opacity 0.15s,border-color 0.15s;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <span title="Trage pentru a reordona"
                style="font-size:18px;color:rgba(255,255,255,0.18);cursor:grab;user-select:none;flex-shrink:0;line-height:1.4;padding-top:1px;">⠿</span>
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
    </div>`;
  }).join('');

  // ── Drag-and-drop reordering ──────────────────────────
  let dragSrc = null;

  Array.from(cards.children).forEach(card => {
    card.addEventListener('dragstart', ev => {
      dragSrc = card;
      ev.dataTransfer.effectAllowed = 'move';
      setTimeout(() => { card.style.opacity = '0.35'; }, 0);
    });
    card.addEventListener('dragend', () => {
      dragSrc = null;
      Array.from(cards.children).forEach(c => { c.style.opacity = ''; c.style.borderColor = ''; });
    });
    card.addEventListener('dragover', ev => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      if (card !== dragSrc) card.style.borderColor = 'rgba(79,195,247,0.55)';
    });
    card.addEventListener('dragleave', () => { card.style.borderColor = ''; });
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

window.removeWatchlistEntry = function (idx) {
  const list = loadWatchlist();
  list.splice(idx, 1);
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
  renderWatchlist();
};

// ── Export watchlist ca fisiere HTML ──────────────────

export function exportWatchlistHTML() {
  const list = loadWatchlist();
  if (!list.length) { alert('Lista e goala!'); return; }

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
      ${e.comment ? `<div class="comment">${e.comment.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}</div>` : ''}
      ${e.charts ? `
        <div class="charts-grid">
          ${[30, 90, 180, 360].filter(d => e.charts[d]).map(days => `
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

// ── Import watchlist din fisiere HTML ─────────────────

function parseWatchlistFromHTML(html, filename) {
  const jsonMatch = html.match(/<script[^>]+id="mc-data"[^>]*>([\s\S]*?)<\/script>/i);
  if (jsonMatch) {
    try {
      const entry = JSON.parse(jsonMatch[1].trim());
      if (entry && entry.ticker) return entry;
    } catch (_) {}
  }

  const getText = pat => { const m = html.match(pat); return m ? m[1].trim() : null; };

  const ticker =
    getText(/<h1[^>]*>.*?📌\s*([A-Z0-9.\-]+)/i) ||
    getText(/<span class="ticker">([^<]+)<\/span>/i) ||
    filename.replace(/-urmarit\.html$/i, '').replace(/\.html$/i, '').toUpperCase();
  if (!ticker) return null;

  const name      = getText(/<span class="name">([^<]+)<\/span>/i) || ticker;
  const priceRaw  = getText(/<span class="price">([^<]+)<\/span>/i) || '';
  const priceParts = priceRaw.trim().split(/\s+/);
  const currency  = priceParts.length >= 2 ? priceParts[0] : 'USD';
  const price     = priceParts.length >= 2 ? priceParts.slice(1).join(' ') : priceRaw;
  const dateRaw   = getText(/<span class="date">([^<]+)<\/span>/i) || '';
  const timeRaw   = getText(/<span class="time">([^<]+)<\/span>/i) ||
                    getText(/<span[^>]*class="time"[^>]*>([^<]+)<\/span>/i) || '';
  const dateSplit = dateRaw.split('·').map(s => s.trim());
  const date = dateSplit[0] || '';
  const time = timeRaw || dateSplit[1] || '';

  const pills = [];
  const pillRe = /<span class="pill">([^<]+)<\/span>/gi;
  let pm;
  while ((pm = pillRe.exec(html)) !== null) pills.push(pm[1].trim());

  const commentMatch = html.match(/<div class="comment">([\s\S]*?)<\/div>/i);
  const comment = commentMatch
    ? commentMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : '';

  const charts = {};
  const imgRe  = /<img[^>]+src="(data:image\/[^"]+)"[^>]+alt="(Traj|Hist) (\d+)z"/gi;
  let im;
  while ((im = imgRe.exec(html)) !== null) {
    const [, src, type, dStr] = im;
    const d = parseInt(dStr);
    if (!charts[d]) charts[d] = {};
    charts[d][type.toLowerCase()] = src;
  }
  const imgRe2 = /<img[^>]+alt="(Traj|Hist) (\d+)z"[^>]+src="(data:image\/[^"]+)"/gi;
  while ((im = imgRe2.exec(html)) !== null) {
    const [, type, dStr, src] = im;
    const d = parseInt(dStr);
    if (!charts[d]) charts[d] = {};
    if (!charts[d][type.toLowerCase()]) charts[d][type.toLowerCase()] = src;
  }

  return { ticker, name, price, currency, date, time, pills, comment, charts };
}

export function importWatchlistFiles(files) {
  if (!files || !files.length) return;
  let done = 0, imported = 0;

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
