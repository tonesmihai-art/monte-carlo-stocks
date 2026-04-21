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
  return {
    closes, dates, volumes,
    currentPrice: closes[closes.length - 1],
    ticker:       meta.symbol,
    currency:     meta.currency || 'USD',
    name:         meta.longName || meta.shortName || ticker,
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
  $('run-btn').disabled    = true;
  $('run-btn').textContent = 'Se ruleaza...';

  try {
    // ── 1. Date istorice ─────────────────────────────
    setStatus(`Descarc date pentru ${ticker}...`);
    const stock = await fetchStockData(ticker);
    const { closes, dates, volumes, currentPrice, currency, name } = stock;
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

    // ── 2b. Volatilitate implicita din optiuni (IV) + Skew ──
    setStatus('Caut volatilitate implicita si skew din optiuni...');
    let ivData = null;
    try { ivData = await fetchImpliedVolatility(ticker, currentPrice, msg => setStatus(msg)); } catch (e) { /* silent */ }

    // ── Fallback: IV estimat din VIX + sigma istorica ──
    // Folosit cand API-urile de optiuni nu raspund (EU/RO stocks, CORS, etc.)
    let ivEstimated = false;
    if (!ivData) {
      setStatus('IV: calculez estimat din VIX + caracteristici actiune...');
      try {
        const vixFallback = await Promise.race([
          fetchVIX(),
          new Promise(res => setTimeout(() => res(null), 4000)),
        ]);
        const vixVal = vixFallback?.vix;
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

    // Raport de ajustare pentru sigmaAdj (calculat mai tarziu, dupa sentiment)
    let sigmaAdjRatio = null;

    // ── 3. Sector + VIX (independent, intotdeauna rulat) ─
    setStatus('Detectez sector si VIX...');
    let sectorWeights = null;
    let vixData       = { vix: null, vixLabel: 'N/A', vixImpact: 0 };
    try {
      const sectorInfo = await fetchSectorData(ticker);
      sectorWeights    = sectorInfo.weights;
      vixData          = await fetchVIX();
      renderSectorBadge(sectorInfo.sector, sectorInfo.industry, vixData, sectorInfo.weights);
    } catch (e) {
      console.warn('Sector/VIX error:', e);
    }

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
    const PERIODS       = [30, 90, 180, 360];
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

      const matrix    = simulate(currentPrice, driftSkewed, sigmaBlended, days, null,          null,          meanRevStrength, mean50, garch, nu);
      const matrixAdj = driftAdjSkewed != null
        ? simulate(currentPrice, driftSkewed, sigmaBlended, days, driftAdjSkewed, sigmaAdjBlended, meanRevStrength, mean50, garch, nu) : null;
      periodResults[days] = {
        days,
        stats:    calcStats(matrix, days, currentPrice),
        statsAdj: matrixAdj ? calcStats(matrixAdj, days, currentPrice) : null,
        percs:    percentilesPerDay(matrix, days),
        percsAdj: matrixAdj ? percentilesPerDay(matrixAdj, days) : null,
        currentPrice, currency, ticker,
      };
    }

    currentResult = { stock, periodResults, sentimentData, drift, sigma, driftAdj, sigmaAdj, garch, nu };

    // ── 6. Salveaza istoric ──────────────────────────
    saveIstoric(ticker, `${currency} ${fmt(currentPrice)}`);
    renderIstoric();

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
  $('run-btn').addEventListener('click', runSimulation);
  $('ticker-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') runSimulation();
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
