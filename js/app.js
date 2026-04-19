// ─────────────────────────────────────────────────────
//  APP.JS — Orchestrare principala
// ─────────────────────────────────────────────────────

window.addEventListener('load', () => {
    const istoric = JSON.parse(localStorage.getItem('istoricSimulari')) || [];
    const container = document.getElementById('status'); 

    if (istoric.length > 0) {
        let html = '<div style="margin-top:10px;"><strong>Istoric (clic pentru simulare):</strong><br>';
        istoric.forEach(item => {
            // Creăm un "chip" clicabil pentru fiecare ticker
            html += `<button class="example-chip history-item" 
                             style="margin: 5px; cursor: pointer;" 
                             data-ticker="${item.ticker}">
                        ${item.ticker} (${item.pret})
                     </button>`;
        });
        html += '</div>';
        container.innerHTML = html;
        container.style.display = 'block';

        // Adăugăm evenimentul de clic pe fiecare element din istoric
        document.querySelectorAll('.history-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const ticker = btn.getAttribute('data-ticker');
                document.getElementById('ticker-input').value = ticker;
                document.getElementById('run-btn').click(); // Pornește automat simularea
            });
        });
    }
});



import { calcParams, simulate, calcStats, percentilesPerDay,
         adjustParams, NUM_SIMS } from './montecarlo.js';
import { analyzeSentiment } from './sentiment.js';
import { drawPriceHistory, drawTrajectories,
         drawHistogram, drawSentiment, destroyAll } from './charts.js';

// ── Service Worker ────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ── State ────────────────────────────────────────────
let currentResult = null;

// ── DOM refs ─────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Yahoo Finance via CORS proxy ─────────────────────
async function fetchStockData(ticker) {
  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
  const proxy = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  const r     = await fetch(proxy);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data  = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Ticker invalid sau date indisponibile');

  const closes = result.indicators.quote[0].close.filter(Boolean);
  const timestamps = result.timestamp;
  const dates  = timestamps.map(ts =>
    new Date(ts * 1000).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' })
  ).filter((_, i) => result.indicators.quote[0].close[i] != null);

  const meta  = result.meta;
  return {
    closes,
    dates,
    currentPrice: closes[closes.length - 1],
    ticker:       meta.symbol,
    currency:     meta.currency || 'USD',
    name:         meta.longName || meta.shortName || ticker,
  };
}

// ── UI Helpers ───────────────────────────────────────
function setStatus(msg, type = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.className   = `status status--${type}`;
  el.style.display = msg ? 'block' : 'none';
}

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  $(id)?.classList.add('active');
  // Update nav
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.section === id));
}

function fmt(n, dec = 2) {
  return n == null ? '—' : n.toLocaleString('en-US', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

function pctDiff(p, ref) {
  const d = (p / ref - 1) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

function renderStatsCard(stats, statsAdj, currentPrice, days, currency) {
  const sym = currency === 'USD' ? '$' : currency + ' ';

  function row(label, valC, valA, color) {
    return `
      <tr>
        <td class="stat-label">${label}</td>
        <td class="stat-val" style="color:${color||'#fff'}">${sym}${fmt(valC)}</td>
        ${valA != null
          ? `<td class="stat-val ai-col">${sym}${fmt(valA)}</td>`
          : `<td class="stat-val ai-col">—</td>`}
      </tr>`;
  }

  function pctRow(label, valC, valA, color) {
    return `
      <tr>
        <td class="stat-label">${label}</td>
        <td class="stat-val" style="color:${color||'#fff'}">${fmt(valC, 1)}%</td>
        ${valA != null
          ? `<td class="stat-val ai-col">${fmt(valA, 1)}%</td>`
          : `<td class="stat-val ai-col">—</td>`}
      </tr>`;
  }

  return `
    <div class="stats-card">
      <div class="stats-title">Statistici — ${days} zile</div>
      <table class="stats-table">
        <thead>
          <tr>
            <th></th>
            <th style="color:#4fc3f7">Clasic</th>
            <th style="color:#ffa726">AI Ajustat</th>
          </tr>
        </thead>
        <tbody>
          <tr><td colspan="3" class="stat-sep">Preturi estimate</td></tr>
          ${row('Pret curent',    currentPrice, null,              '#fff')}
          ${row('Medie',          stats.mean,  statsAdj?.mean,    '#ffee58')}
          ${row('Median',         stats.median,statsAdj?.median,  '#fff')}
          ${row('P90 — optimist', stats.p90,   statsAdj?.p90,     '#66bb6a')}
          ${row('P10 — pesimist', stats.p10,   statsAdj?.p10,     '#ef5350')}
          ${row('Max simulat',    stats.max,   statsAdj?.max,     '#4fc3f7')}
          ${row('Min simulat',    stats.min,   statsAdj?.min,     '#4fc3f7')}
          <tr><td colspan="3" class="stat-sep">Probabilitati</td></tr>
          ${pctRow('Prob. profit',    stats.probProfit, statsAdj?.probProfit, '#66bb6a')}
          ${pctRow('Prob. gain > 10%',stats.probGain10, statsAdj?.probGain10, '#66bb6a')}
          ${pctRow('Prob. loss > 10%',stats.probLoss10, statsAdj?.probLoss10, '#ef5350')}
        </tbody>
      </table>
      <div class="stats-footer">
        ${fmt(NUM_SIMS.toLocaleString())} simulari GBM
      </div>
    </div>`;
}

// ── Render perioda (tab) ──────────────────────────────
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
  const ticker    = $('ticker-input').value.trim().toUpperCase();
  const doSentiment = $('toggle-sentiment').checked;

  if (!ticker) { setStatus('Introdu un ticker.', 'error'); return; }

  destroyAll();
  $('results-section').style.display = 'none';
  $('sentiment-section').style.display = 'none';
  $('run-btn').disabled = true;
  $('run-btn').textContent = 'Se ruleaza...';

  try {
    // ── 1. Date istorice ─────────────────────────────
    setStatus(`Descarc date pentru ${ticker}...`);
    const stock = await fetchStockData(ticker);
    const { closes, dates, currentPrice, currency, name } = stock;

    // Afisam pret curent
    $('stock-name').textContent   = name;
    $('stock-price').textContent  = `${currency} ${fmt(currentPrice)}`;
    $('stock-ticker').textContent = ticker;

    drawPriceHistory('price-chart', dates.slice(-60), closes.slice(-60), ticker);

    // ── 2. Parametri GBM ─────────────────────────────
    setStatus('Calculez parametri GBM...');
    const { drift, sigma } = calcParams(closes);

    $('info-sigma').textContent = `${(sigma * 100).toFixed(3)}%/zi`;
    $('info-vol').textContent   = `${(sigma * Math.sqrt(252) * 100).toFixed(1)}%/an`;
    $('info-drift').textContent = `${(drift * 100).toFixed(4)}%/zi`;

    // ── 3. Sentiment AI ──────────────────────────────
    let sentimentData = null;
    let driftAdj = null, sigmaAdj = null;

    if (doSentiment) {
      setStatus('Analizez sentiment (Yahoo + Reuters + Google News)...');
      try {
        sentimentData = await analyzeSentiment(ticker, name, msg => setStatus(msg));
        const scores  = Object.values(sentimentData.factori).map(f => f.scor);
        const adj     = adjustParams(drift, sigma, scores);
        driftAdj      = adj.driftAdj;
        sigmaAdj      = adj.sigmaAdj;

        $('sent-global').textContent = `${sentimentData.sentimentGlobal >= 0 ? '+' : ''}${sentimentData.sentimentGlobal.toFixed(3)}`;
        $('sent-global').style.color = sentimentData.sentimentGlobal > 0.1 ? '#66bb6a'
                                     : sentimentData.sentimentGlobal < -0.1 ? '#ef5350' : '#ffee58';
        $('sent-conclusion').textContent = sentimentData.concluzie;
        $('sent-sources').textContent =
          `Yahoo: ${sentimentData.surse.yahoo} | Reuters: ${sentimentData.surse.reuters} | Google: ${sentimentData.surse.google} | Total: ${sentimentData.totalStiri} stiri unice`;

        drawSentiment('sentiment-chart', sentimentData);
        $('sentiment-section').style.display = 'block';

        // Detalii factori
        const detailsHtml = Object.entries(sentimentData.factori).map(([key, f]) => `
          <div class="factor-card ${f.impact}">
            <div class="factor-header">
              <span class="factor-label">${f.label}</span>
              <span class="factor-score">${f.scor >= 0 ? '+' : ''}${f.scor.toFixed(3)}</span>
              <span class="factor-impact impact-${f.impact}">${f.impact.toUpperCase()}</span>
            </div>
            <div class="factor-count">${f.count} stiri analizate</div>
            ${f.stiri.slice(0,3).map(s =>
              `<div class="factor-news" style="color:${s.score>0.05?'#a5d6a7':s.score<-0.05?'#ef9a9a':'#888'}">
                 ${s.sursa}: ${s.titlu.slice(0,90)}${s.titlu.length>90?'...':''}
               </div>`
            ).join('')}
          </div>`).join('');
        $('factors-detail').innerHTML = detailsHtml;

      } catch (e) {
        console.warn('Sentiment error:', e);
        setStatus('Sentiment indisponibil — continuam fara.', 'warn');
      }
    }

    // ── 4. Simulari Monte Carlo ───────────────────────
    const PERIODS = [30, 90, 180, 360];
    const periodResults = {};

    for (const days of PERIODS) {
      setStatus(`Simulez ${days} zile (${NUM_SIMS.toLocaleString()} scenarii)...`);
      await new Promise(r => setTimeout(r, 0)); // yield UI

      const matrix    = simulate(currentPrice, drift, sigma, days);
      const matrixAdj = (driftAdj != null)
        ? simulate(currentPrice, drift, sigma, days, driftAdj, sigmaAdj)
        : null;

      periodResults[days] = {
        days,
        stats:       calcStats(matrix, days, currentPrice),
        statsAdj:    matrixAdj ? calcStats(matrixAdj, days, currentPrice) : null,
        percs:       percentilesPerDay(matrix, days),
        percsAdj:    matrixAdj ? percentilesPerDay(matrixAdj, days) : null,
        currentPrice,
        currency,
        ticker,
      };
    }

    currentResult = { stock, periodResults, sentimentData, drift, sigma, driftAdj, sigmaAdj };

//267-276 Presupunem că 'rezultate' este obiectul sau array-ul tău cu datele finale
const tickerNou = document.getElementById('ticker-input').value.toUpperCase();
const pretNou = document.getElementById('stock-price').innerText;

let istoric = JSON.parse(localStorage.getItem('istoricSimulari')) || [];

// Eliminăm ticker-ul dacă exista deja (ca să îl punem la început ca fiind cel mai nou)
istoric = istoric.filter(item => item.ticker !== tickerNou);

// Adăugăm noile date la început
istoric.unshift({
    ticker: tickerNou,
    pret: pretNou,
    timestamp: new Date().toLocaleTimeString()
});

// Păstrăm doar ultimele 10 pentru a nu aglomera ecranul
localStorage.setItem('istoricSimulari', JSON.stringify(istoric.slice(0, 10)));

// 2. LINIA NOUĂ: Forțează interfața să deseneze noile butoane în "Recent"
window.dispatchEvent(new Event('load'));
      
localStorage.setItem('ultimaSimulare', JSON.stringify(dateDeSalvat));
console.log("Simularea a fost salvată local!");

    // ── 5. Randare rezultate ─────────────────────────
    setStatus('');
    $('results-section').style.display = 'block';

    // Tab-uri perioade
    const tabsEl   = $('period-tabs');
    const chartEl  = $('chart-area');
    tabsEl.innerHTML = '';

    PERIODS.forEach((days, i) => {
      const btn = document.createElement('button');
      btn.className   = `tab-btn ${i === 0 ? 'active' : ''}`;
      btn.textContent = `${days} zile`;
      btn.onclick     = () => {
        tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        destroyAll();
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
    $('run-btn').disabled = false;
    $('run-btn').textContent = 'Ruleaza simularea';
  }
}

// ── Event listeners ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('run-btn').addEventListener('click', runSimulation);
  $('ticker-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') runSimulation();
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });

  // Exemple rapide
  document.querySelectorAll('.example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('ticker-input').value = chip.dataset.ticker;
    });
  });
});
