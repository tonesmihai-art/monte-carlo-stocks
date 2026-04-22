// ─────────────────────────────────────────────────────
//  VALUATION.JS — Evaluare fundamentala (PE, FCF, NAV, DCF)
//                 + comentariu calitativ GBM
// ─────────────────────────────────────────────────────

import { $, fmt, setPillColor } from './ui.js';
import { fetchValuationFundamentals } from './api.js';

// ── Ponderi per sector ────────────────────────────────

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

export const YAHOO_TO_VAL_SECTOR = {
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

// ── Calcul valuare — 4 metode ─────────────────────────

function calcValuare({ eps, pe, fcf, growth, wacc, tgr, assets, cash, debt, shares, sector }) {
  const w = VAL_SECTOR_WEIGHTS[sector] || VAL_SECTOR_WEIGHTS.tech;

  const valEPS = (eps > 0 && pe > 0) ? eps * pe : null;
  const valFCF = (fcf > 0 && pe > 0) ? fcf * pe : null;
  const valNAV = (assets != null && cash != null && debt != null && shares > 0)
    ? (assets + cash - debt) / shares
    : null;

  let valDCF = null;
  if (fcf > 0 && growth != null && wacc != null && tgr != null && wacc > tgr) {
    const g = growth / 100, r = wacc / 100, t = tgr / 100;
    let dcfSum = 0;
    for (let n = 1; n <= 10; n++) {
      dcfSum += (fcf * Math.pow(1 + g, n)) / Math.pow(1 + r, n);
    }
    const fcf10      = fcf * Math.pow(1 + g, 10);
    const terminalPV = (fcf10 * (1 + t) / (r - t)) / Math.pow(1 + r, 10);
    valDCF = dcfSum + terminalPV;
  }

  const methods = [
    { val: valEPS, w: w.eps }, { val: valFCF, w: w.fcf },
    { val: valNAV, w: w.nav }, { val: valDCF, w: w.dcf },
  ];
  const avail = methods.filter(m => m.val != null && isFinite(m.val));
  let weighted = null;
  if (avail.length > 0) {
    const totalW = avail.reduce((s, m) => s + m.w, 0);
    weighted = avail.reduce((s, m) => s + m.val * m.w / totalW, 0);
  }
  return { valEPS, valFCF, valNAV, valDCF, weighted, w };
}

// ── Actualizeaza UI dupa orice modificare input ───────

export function updateValuare() {
  const getNum = id => {
    const v = parseFloat($(`val-${id}`)?.value);
    return isNaN(v) ? null : v;
  };
  const sector    = $('val-sector')?.value || 'tech';
  const priceEl   = $('val-current-price');
  const curPrice  = priceEl ? parseFloat(priceEl.dataset.price)   : 0;
  const currency  = priceEl ? (priceEl.dataset.currency || 'USD') : 'USD';
  const sym       = currency === 'USD' ? '$' : currency + ' ';

  const { valEPS, valFCF, valNAV, valDCF, weighted, w } = calcValuare({
    eps: getNum('eps'), pe: getNum('pe'), fcf: getNum('fcf'),
    growth: getNum('growth'), wacc: getNum('wacc'), tgr: getNum('tgr'),
    assets: getNum('assets'), cash: getNum('cash'), debt: getNum('debt'),
    shares: getNum('shares'), sector,
  });

  function fv(v) { return v != null ? `${sym}${v.toFixed(2)}` : '—'; }

  let marginHtml = '';
  if (weighted != null && curPrice > 0) {
    const margin = (weighted - curPrice) / curPrice * 100;
    const color  = margin > 20 ? '#66bb6a' : margin > 0 ? '#ffee58' : '#ef5350';
    const label  = margin > 20 ? '✔ Subapreciat' : margin > 0 ? '≈ Corect evaluat' : '✘ Supraevaluat';
    marginHtml = `
      <div class="val-margin-card" style="background:${color}18;border:1px solid ${color}44;">
        <div class="vm-label" style="color:${color}99;">Marja siguranta</div>
        <div class="vm-val"   style="color:${color};">${margin >= 0 ? '+' : ''}${margin.toFixed(1)}%</div>
        <div class="vm-weight" style="color:${color}77;">${label}</div>
      </div>`;
  }

  const grid = $('val-results-grid');
  if (!grid) return;

  // ── Comentariu calitativ fundamental + tehnic ────────
  const commentEl = ensureFundComment();
  if (commentEl) {
    const margin = (weighted != null && curPrice > 0)
      ? (weighted - curPrice) / curPrice * 100
      : null;
    commentEl.innerHTML = generateFundamentalComment(weighted, curPrice, margin, sym);
    commentEl.style.display = 'block';
  }

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

window.toggleValuare = function () {
  const content = $('val-content');
  const icon    = $('val-toggle-icon');
  if (!content || !icon) return;
  const isOpen = content.style.display !== 'none';
  content.style.display = isOpen ? 'none' : 'block';
  icon.textContent = isOpen ? '▼ Extinde' : '▲ Restrânge';
};

// ── Context tehnic (MA60, drift, sigma) ──────────────
let _techCtx = {};

// ── Comentariu calitativ fundamental + tehnic ─────────

function ensureFundComment() {
  let el = document.getElementById('val-fundamental-comment');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'val-fundamental-comment';
  el.style.display = 'none';
  // Insereaza dupa val-results-grid (sau la finalul val-content)
  const grid = document.getElementById('val-results-grid');
  if (grid?.parentNode) grid.parentNode.appendChild(el);
  else document.getElementById('val-content')?.appendChild(el);
  return el;
}

function generateFundamentalComment(weighted, curPrice, margin, sym) {
  const { deviationPct, drift, sigma, mean50 } = _techCtx;
  const hasTech = deviationPct != null;

  // ── Verdict fundamental ──────────────────────────────
  let fundLabel, fundColor, fundAdvice;
  if (weighted == null || curPrice <= 0) {
    fundLabel  = 'Valuare insuficientă';
    fundColor  = 'rgba(255,255,255,0.4)';
    fundAdvice = 'Completează câmpurile EPS/FCF/WACC pentru a calcula valuarea intrinsecă.';
  } else if (margin > 20) {
    fundLabel  = '✔ Subapreciată — potențial de creștere';
    fundColor  = '#66bb6a';
    fundAdvice = `Prețul curent (${sym}${curPrice.toFixed(2)}) este cu <strong style="color:#66bb6a">${margin.toFixed(1)}%</strong> sub valoarea fundamentală estimată (${sym}${weighted.toFixed(2)}). Compania pare <em>subapreciată</em> — un candidat solid dacă fundamentele sunt stabile.`;
  } else if (margin > 0) {
    fundLabel  = '≈ Corect evaluată';
    fundColor  = '#ffee58';
    fundAdvice = `Prețul curent (${sym}${curPrice.toFixed(2)}) este aproape de valoarea fundamentală estimată (${sym}${weighted.toFixed(2)}). Marja de siguranță este redusă (${margin.toFixed(1)}%) — intrarea depinde în mare măsură de timing-ul tehnic.`;
  } else {
    fundLabel  = '✘ Supraevaluată — risc la prețul curent';
    fundColor  = '#ef5350';
    fundAdvice = `Prețul curent (${sym}${curPrice.toFixed(2)}) depășește cu <strong style="color:#ef5350">${Math.abs(margin).toFixed(1)}%</strong> valoarea fundamentală estimată (${sym}${weighted.toFixed(2)}). Riscul de corecție este ridicat dacă așteptările de creștere nu se materializează.`;
  }

  // ── Timing tehnic ────────────────────────────────────
  let techHtml = '';
  if (hasTech) {
    const dev   = deviationPct;
    const sigAnn = (sigma ?? 0) * Math.sqrt(252) * 100;
    let techLabel, techColor, techAdvice;

    if (dev < -15) {
      techLabel  = '📉 Preț mult sub MA60 — zonă de acumulare';
      techColor  = '#66bb6a';
      techAdvice = `Prețul se află cu <strong style="color:#66bb6a">${Math.abs(dev).toFixed(1)}%</strong> sub media mobilă pe 60 de zile — semnal de <em>oversold</em>. Statistic, aceasta este o fereastră favorabilă de intrare pentru investitorii pe termen mediu/lung.`;
    } else if (dev < -5) {
      techLabel  = '📊 Preț ușor sub MA60 — condiții favorabile';
      techColor  = '#a5d6a7';
      techAdvice = `Prețul este cu ${Math.abs(dev).toFixed(1)}% sub MA60 — ușor corectat față de medie. Condiții tehnice favorabile pentru o intrare incrementală.`;
    } else if (dev <= 5) {
      techLabel  = '➡ Preț la MA60 — neutral tehnic';
      techColor  = '#ffee58';
      techAdvice = `Prețul se tranzacționează în jurul mediei mobile pe 60 de zile (±${Math.abs(dev).toFixed(1)}%). Nu există un semnal tehnic clar — intrarea e posibilă, dar fără avantaj de pricing față de tendința medie.`;
    } else if (dev <= 15) {
      techLabel  = '📈 Preț ușor peste MA60 — urmărește o corecție';
      techColor  = '#ffa726';
      techAdvice = `Prețul este cu ${dev.toFixed(1)}% peste MA60. Momentul tehnic nu e optim pentru o intrare nouă — ideal ar fi să aștepți o retragere spre medie sau spre un suport tehnic clar.`;
    } else {
      techLabel  = '🔺 Preț extins peste MA60 — evită intrarea acum';
      techColor  = '#ef5350';
      techAdvice = `Prețul este cu <strong style="color:#ef5350">${dev.toFixed(1)}%</strong> peste MA60 — extins tehnic. Intrarea acum crește riscul de a cumpăra la vârf local. Strategia recomandată: <em>așteaptă o corecție semnificativă</em>.`;
    }

    // ── Pret de intrare sugerat ──────────────────────────
    let entryPriceHtml = '';
    if (curPrice > 0 && mean50 != null && mean50 > 0) {
      const entryMA     = mean50;                          // MA60 = entry tehnic ideal
      const entryFund   = weighted != null ? Math.min(weighted * 0.97, curPrice * 0.93) : null; // -3% sub fundamental
      const bestEntry   = entryFund != null
        ? Math.min(entryMA, entryFund)
        : entryMA;
      const discountPct = ((curPrice - bestEntry) / curPrice * 100).toFixed(1);
      if (bestEntry < curPrice) {
        entryPriceHtml = `
          <div class="vfc-entry-box">
            <strong>🎯 Preț țintă de intrare</strong>
            Zona favorabilă: <span style="color:#66bb6a;font-weight:700">${sym}${bestEntry.toFixed(2)}</span>
            ${entryFund != null ? ` &nbsp;·&nbsp; MA60: ${sym}${entryMA.toFixed(2)} &nbsp;·&nbsp; −3% sub fundamental: ${sym}${entryFund.toFixed(2)}` : `&nbsp;·&nbsp; (MA60)`}
            <span style="color:#ffa726"> ≈ −${discountPct}% față de prețul actual</span>
          </div>`;
      }
    }

    techHtml = `
      <div class="vfc-row" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.07)">
        <span style="color:${techColor};font-weight:600">${techLabel}</span><br>
        <span style="color:rgba(255,255,255,0.75)">${techAdvice}</span>
        ${entryPriceHtml}
      </div>
      <div class="vfc-row" style="margin-top:6px;font-size:10px;color:rgba(255,255,255,0.4)">
        Strategie: alegi compania după <em>fundamentale</em>, intri tehnic când prețul e jos — MA60 deviere ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}% · vol ${sigAnn.toFixed(0)}%/an
      </div>`;
  }

  return `
    <div class="vfc-title">📋 Analiză Fundamentală + Timing Tehnic</div>
    <div class="vfc-row">
      <span style="color:${fundColor};font-weight:600">${fundLabel}</span>
    </div>
    <div class="vfc-row" style="color:rgba(255,255,255,0.8)">${fundAdvice}</div>
    ${techHtml}`;
}

// ── Seteaza un input + flash verde ────────────────────

export function setValInput(id, value, decimals = 2) {
  const el = $(`val-${id}`);
  if (!el || value == null || !isFinite(value)) return;
  el.value = parseFloat(value.toFixed(decimals));
  el.style.borderColor = 'rgba(102,187,106,0.7)';
  setTimeout(() => { el.style.borderColor = ''; }, 1200);
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

// ── Initializeaza panelul + fetch date fundamentale ───

export function initValuarePanel(currentPrice, currency, yahooSector, ticker, metaFundamentals = {}, technicalCtx = {}) {
  _techCtx = technicalCtx;
  const panel = $('valuation-panel');
  if (!panel) return;

  let priceEl = $('val-current-price');
  if (!priceEl) {
    priceEl = document.createElement('span');
    priceEl.id = 'val-current-price';
    priceEl.style.display = 'none';
    panel.appendChild(priceEl);
  }
  priceEl.dataset.price    = currentPrice;
  priceEl.dataset.currency = currency || 'USD';

  if (yahooSector && YAHOO_TO_VAL_SECTOR[yahooSector]) {
    const sel = $('val-sector');
    if (sel) sel.value = YAHOO_TO_VAL_SECTOR[yahooSector];
  }

  if (!panel.dataset.listenersAttached) {
    ['sector','eps','pe','fcf','growth','wacc','tgr','assets','cash','debt','shares'].forEach(id => {
      const el = $(`val-${id}`);
      el?.addEventListener('input',  updateValuare);
      el?.addEventListener('change', updateValuare);
    });
    panel.dataset.listenersAttached = '1';
  }

  panel.style.display = 'block';

  const statusEl = ensureValStatus();
  let metaPopulated = 0;
  if (metaFundamentals.eps    != null) { setValInput('eps',    metaFundamentals.eps,    2); metaPopulated++; }
  if (metaFundamentals.pe     != null) { setValInput('pe',     metaFundamentals.pe,     1); metaPopulated++; }
  if (metaFundamentals.shares != null) { setValInput('shares', metaFundamentals.shares, 0); metaPopulated++; }

  if (metaPopulated > 0) {
    statusEl.textContent = `✔ EPS + P/E din chart API · se descarcă FCF, cash, datorii...`;
    statusEl.style.color = 'rgba(102,187,106,0.55)';
  } else {
    statusEl.textContent = '⏳ Se descarcă date fundamentale...';
    statusEl.style.color = 'rgba(255,255,255,0.4)';
  }
  updateValuare();

  if (!ticker) return;
  fetchValuationFundamentals(ticker).then(d => {
    if (metaFundamentals.eps == null) setValInput('eps', d.eps, 2);
    if (metaFundamentals.shares == null) setValInput('shares', d.shares, 0);
    setValInput('fcf',    d.fcfPerShare, 2);
    setValInput('assets', d.totalAssets, 0);
    setValInput('cash',   d.cash,        0);
    setValInput('debt',   d.debt,        0);
    setValInput('growth', d.growth,      1);

    // PE: din Yahoo quote; daca lipseste, calculeaza din pret/EPS
    if (metaFundamentals.pe == null) {
      const peVal = d.pe ?? (() => {
        const curPrice = parseFloat($('val-current-price')?.dataset.price);
        const epsVal   = parseFloat($('val-eps')?.value);
        return (epsVal > 0 && curPrice > 0) ? curPrice / epsVal : null;
      })();
      setValInput('pe', peVal, 1);
    }

    statusEl.textContent = '✔ Date SEC + Yahoo · WACC, rata terminală — completează manual';
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

// ── Comentariu calitativ bazat pe toti coeficientii ───

export function generateQualityComment({ sigma, volAnualPct, nu, garch, drift, deviationPct, volumeTrend, ivData, ivEstimated }) {
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
  const vtStr    = vtDetail === 'bullish'       ? ', volum confirma cresterea'
                 : vtDetail === 'bearish'       ? ', volum confirma scaderea'
                 : vtDetail.includes('bullish') ? ', divergenta bullish la volum'
                 : vtDetail.includes('bearish') ? ', divergenta bearish la volum'
                 :                                '';
  parts.push(`Tendinta: ${driftStr}, ${maStr}${vtStr}.`);

  // ── 4. Semnalul optiunilor / IV ──────────────────────
  if (ivData) {
    const ivRatio  = ivData.ivDaily / sigma;
    const ivStr    = ivRatio < 0.85 ? 'Piata nu anticipeaza miscari majore (IV redus)'
                   : ivRatio < 1.20 ? 'Risc anticipat in linie cu trecutul'
                   : ivRatio < 1.60 ? 'Piata pretinde miscare importanta (IV ridicat)'
                   :                  'Tensiune maxima — eveniment major posibil';
    const skew     = ivData.skewData?.skew;
    const skewStr  = skew == null    ? ''
                   : skew > 0.15     ? ', put-uri scumpe — teama puternica de scadere'
                   : skew > 0.07     ? ', skew normal bearish'
                   : skew < 0        ? ', call-uri mai scumpe — sentiment bullish in optiuni'
                   :                   ', skew echilibrat';
    const estStr   = ivEstimated ? ' <span style="opacity:0.5">(estimat din VIX)</span>' : '';
    parts.push(`${ivStr}${skewStr}${estStr}.`);
  }

  return parts.join('<br>');
}
