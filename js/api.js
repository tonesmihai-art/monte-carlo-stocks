// ─────────────────────────────────────────────────────
//  API.JS — Fetch date: Yahoo Finance, Nasdaq IV, SEC EDGAR
// ─────────────────────────────────────────────────────

// ── Yahoo Finance via CORS proxy ─────────────────────
export async function fetchStockData(ticker) {
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

  const sharesRaw = meta.sharesOutstanding ?? null;
  const epsRaw    = meta.epsTrailingTwelveMonths ?? null;
  const fundamentals = {
    eps:    (epsRaw != null && typeof epsRaw === 'object') ? epsRaw.raw ?? null : epsRaw,
    shares: sharesRaw != null ? sharesRaw / 1e6 : null,
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

// ── Volatilitate implicita din optiuni + Put/Call Skew ─
export async function fetchImpliedVolatility(ticker, currentPrice, onProgress) {
  const isUS = !ticker.includes('.') && !ticker.includes('-');

  function parseNasdaqIV(str) {
    if (!str || str === '--' || str === 'N/A') return null;
    const n = parseFloat(str.replace('%', '').replace(',', ''));
    if (isNaN(n) || n <= 0 || n > 500) return null;
    return n / 100;
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
                const ivAnnual  = ivs.reduce((a, b) => a + b, 0) / ivs.length;
                const ivDaily   = ivAnnual / Math.sqrt(252);
                const atmStrike = atmRow.s;

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

  // ── Yahoo Finance v7 fallback ─────────────────────
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

    const allStrikes = [...new Set([...calls.map(c => c.strike), ...puts.map(p => p.strike)])].sort((a, b) => a - b);
    const atmStrike  = allStrikes.reduce((a, b) => Math.abs(b - currentPrice) < Math.abs(a - currentPrice) ? b : a);
    const atmCall = calls.find(c => c.strike === atmStrike);
    const atmPut  = puts.find(p  => p.strike === atmStrike);
    const ivs = [atmCall?.impliedVolatility, atmPut?.impliedVolatility].filter(v => v > 0.01 && v < 5);
    if (!ivs.length) return null;

    const ivAnnual  = ivs.reduce((a, b) => a + b, 0) / ivs.length;
    const ivDaily   = ivAnnual / Math.sqrt(252);
    const daysToExp = Math.round((nearestExp - now) / 86400);

    const putTarget  = currentPrice * 0.93;
    const callTarget = currentPrice * 1.07;
    const otmPuts  = puts.filter(p  => p.strike < currentPrice * 0.98 && p.strike > currentPrice * 0.70);
    const otmCalls = calls.filter(c => c.strike > currentPrice * 1.02 && c.strike < currentPrice * 1.30);
    let skewData = null;
    if (otmPuts.length && otmCalls.length) {
      const otmPut  = otmPuts.reduce((a, b)  => Math.abs(b.strike - putTarget)  < Math.abs(a.strike - putTarget)  ? b : a);
      const otmCall = otmCalls.reduce((a, b) => Math.abs(b.strike - callTarget) < Math.abs(a.strike - callTarget) ? b : a);
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

// ── Combina sigma istorica cu IV dupa orizontul de timp ──
// IV conteaza mult pe termen scurt (30z), scade spre orizonturi lungi
export function blendSigma(sigmaHist, ivDaily, days) {
  if (!ivDaily || ivDaily <= 0) return sigmaHist;
  const ivWeight = Math.max(0.10, Math.min(0.70, 30 / days));
  return ivWeight * ivDaily + (1 - ivWeight) * sigmaHist;
}

// ── Fetch robustez ────────────────────────────────────

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

const _YPX = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

async function _robustGet(url, ms = 10000) {
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
  return arr
    .filter(d => d.val != null && /^(10-K|20-F)/.test(d.form))
    .sort((a, b) => new Date(b.end) - new Date(a.end))[0]?.val ?? null;
}

async function _fetchSEC(ticker) {
  const cik = await _secCIK(ticker);
  if (!cik) throw new Error(`${ticker} nu e in SEC`);

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

// ── Helper: Yahoo returneaza uneori {raw,fmt} chiar si cu formatted=false ──
function _yv(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v.raw ?? null;
  return typeof v === 'number' ? v : null;
}

// ── Yahoo quoteSummary — date fundamentale complete ───
async function _fetchYahooFundamentals(ticker) {
  // Pas 1: quoteSummary — cel mai complet (FCF, cash, debt, PE, growth, EPS)
  const modules = 'financialData,defaultKeyStatistics,summaryDetail';
  const summaryUrls = [
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}&formatted=false`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}&formatted=false`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`,
  ];
  for (const url of summaryUrls) {
    for (const px of _YPX) {
      try {
        const json = await _yGet(px(url), 9000);
        if (typeof json !== 'object') continue;
        const r = json?.quoteSummary?.result?.[0];
        if (!r) continue;
        const fd = r.financialData        || {};
        const ks = r.defaultKeyStatistics || {};
        const sd = r.summaryDetail        || {};

        const sharesRaw = _yv(ks.sharesOutstanding);
        const fcfTotal  = _yv(fd.freeCashflow);
        const fcfPS     = (fcfTotal != null && sharesRaw > 0) ? fcfTotal / sharesRaw : null;

        const eps    = _yv(ks.trailingEps);
        const pe     = _yv(sd.trailingPE) ?? _yv(sd.forwardPE) ?? _yv(ks.trailingPE) ?? null;
        const growth = _yv(fd.earningsGrowth) != null ? _yv(fd.earningsGrowth) * 100
                     : _yv(fd.revenueGrowth)  != null ? _yv(fd.revenueGrowth)  * 100 : null;

        // returnam doar daca avem cel putin un camp util
        if (eps != null || pe != null || fcfTotal != null) {
          return {
            eps,
            pe,
            growth,
            shares:      sharesRaw != null ? sharesRaw / 1e6 : null,
            fcfPerShare: fcfPS,
            cash:        _yv(fd.totalCash) != null ? _yv(fd.totalCash) / 1e6 : null,
            debt:        _yv(fd.totalDebt) != null ? _yv(fd.totalDebt) / 1e6 : null,
          };
        }
      } catch (_) {}
    }
  }

  // Pas 2: fallback — endpoint quote v7/v8 (mai sarac, fara FCF/cash/debt)
  const quoteUrls = [
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&formatted=false`,
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&formatted=false`,
    `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${ticker}`,
    `https://query1.finance.yahoo.com/v8/finance/quote?symbols=${ticker}`,
  ];
  for (const url of quoteUrls) {
    for (const px of _YPX) {
      try {
        const json = await _yGet(px(url), 7000);
        if (typeof json !== 'object') continue;
        const q = json?.quoteResponse?.result?.[0];
        if (!q) continue;
        return {
          eps:    _yv(q.epsTrailingTwelveMonths) ?? _yv(q.trailingEps) ?? null,
          pe:     _yv(q.trailingPE) ?? null,
          growth: _yv(q.earningsGrowth) != null ? _yv(q.earningsGrowth) * 100
                : _yv(q.revenueGrowth)  != null ? _yv(q.revenueGrowth)  * 100 : null,
          shares: _yv(q.sharesOutstanding) != null ? _yv(q.sharesOutstanding) / 1e6 : null,
        };
      } catch (_) {}
    }
  }
  return {};
}

export async function fetchValuationFundamentals(ticker) {
  const isUS = !ticker.includes('.') && !ticker.includes('-');
  const tasks = isUS
    ? [_fetchSEC(ticker), _fetchYahooFundamentals(ticker)]
    : [Promise.resolve({}), _fetchYahooFundamentals(ticker)];

  const [secR, quoteR] = await Promise.allSettled(tasks);
  const sec   = secR.status   === 'fulfilled' ? secR.value   : {};
  const quote = quoteR.status === 'fulfilled' ? quoteR.value : {};

  const result = {
    eps:         quote.eps                            ?? null,
    pe:          quote.pe                             ?? null,
    growth:      quote.growth                         ?? null,
    shares:      sec.shares      ?? quote.shares      ?? null,
    fcfPerShare: sec.fcfPerShare ?? quote.fcfPerShare ?? null,
    totalAssets: sec.totalAssets                      ?? null,
    cash:        sec.cash        ?? quote.cash        ?? null,
    debt:        sec.debt        ?? quote.debt        ?? null,
  };
  if (Object.values(result).every(v => v == null)) throw new Error('Date indisponibile');
  return result;
}
