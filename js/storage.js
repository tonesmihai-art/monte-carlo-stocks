// ─────────────────────────────────────────────────────
//  STORAGE.JS — localStorage: istoric + watchlist
//  Nu atinge DOM-ul — functii pure de date.
// ─────────────────────────────────────────────────────

export const ISTORIC_KEY  = 'istoricSimulari';
export const WATCHLIST_KEY = 'watchlistUrmarit';
const MAX_ISTORIC = 30;

// ── Istoric simulari ─────────────────────────────────

export function loadIstoric() {
  try { return JSON.parse(localStorage.getItem(ISTORIC_KEY)) || []; }
  catch { return []; }
}

export function saveIstoric(ticker, pret) {
  let istoric = loadIstoric();
  istoric     = istoric.filter(item => item.ticker !== ticker);
  istoric.unshift({
    ticker,
    pret,
    timestamp: new Date().toLocaleString('ro-RO', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }),
  });
  localStorage.setItem(ISTORIC_KEY, JSON.stringify(istoric.slice(0, MAX_ISTORIC)));
}

// ── Watchlist ────────────────────────────────────────
export function loadWatchlist() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || [];
  } catch {
    return [];
  }

  const list = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;

    list.push({
      ticker: item.ticker ?? null,
      eps: item.eps ?? null,
      pe: item.pe ?? null,
      shares: item.shares ?? null,
      fcfPerShare: item.fcfPerShare ?? null,
      totalAssets: item.totalAssets ?? null,
      cash: item.cash ?? null,
      debt: item.debt ?? null,
      sources: item.sources ?? {},
    });
  }

  // resalvam în formatul nou
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
  return list;
}

export function saveToWatchlist(entry) {
  if (!entry || typeof entry !== "object" || !entry.ticker) return;

  const normalized = {
    ticker: entry.ticker,
    eps: entry.eps ?? null,
    pe: entry.pe ?? null,
    shares: entry.shares ?? null,
    fcfPerShare: entry.fcfPerShare ?? null,
    totalAssets: entry.totalAssets ?? null,
    cash: entry.cash ?? null,
    debt: entry.debt ?? null,
    sources: entry.sources ?? {},
  };

  let list = loadWatchlist();
  list = list.filter(e => e.ticker !== normalized.ticker);
  list.unshift(normalized);

  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}

