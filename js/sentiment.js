// ─────────────────────────────────────────────────────
//  ANALIZA SENTIMENT — fara API key
//  Surse: Yahoo Finance News + Reuters RSS + Google News
//  Algoritm: VADER-lite implementat in JavaScript
//  + Detectie sector + VIX
// ─────────────────────────────────────────────────────

// Lexicon VADER simplificat (cuvinte financiare + general)
const VADER_LEXICON = {
  'good':0.9,'great':1.5,'excellent':2.0,'strong':1.2,'growth':1.3,
  'profit':1.5,'gains':1.2,'bullish':1.8,'rally':1.4,'surge':1.6,
  'beat':1.3,'record':1.1,'boost':1.2,'rise':0.8,'soar':1.8,
  'upgrade':1.5,'outperform':1.6,'buy':0.8,'positive':1.0,
  'win':1.2,'recover':1.0,'rebound':1.2,'expand':1.0,'increase':0.8,
  'improve':1.0,'innovation':1.1,'launch':0.8,'deal':0.9,'partnership':0.9,
  'dividend':1.0,'revenue':0.5,'acquisition':0.7,'merger':0.5,
  'bad':-0.9,'worst':-1.8,'poor':-1.2,'weak':-1.1,'loss':-1.5,
  'bearish':-1.8,'crash':-2.0,'plunge':-1.8,'fall':-0.9,'drop':-1.0,
  'decline':-1.0,'miss':-1.3,'downgrade':-1.5,'sell':-0.8,'negative':-1.0,
  'concern':-0.8,'risk':-0.7,'warning':-1.2,'crisis':-1.8,'debt':-0.8,
  'layoff':-1.5,'bankrupt':-2.0,'fine':-1.2,'fraud':-1.8,'scandal':-1.8,
  'lawsuit':-1.2,'recall':-1.3,'halt':-1.0,'suspend':-1.0,'cut':-0.9,
  'war':-1.5,'conflict':-1.2,'sanction':-1.3,'tariff':-0.8,'inflation':-0.8,
  'recession':-1.5,'default':-1.8,'volatile':-0.6,'uncertainty':-0.8,
  'very':1.3,'extremely':1.5,'highly':1.2,'significantly':1.2,
};

const NEGATIONS = new Set(['not','no','never','neither','nor','without',
                           'hardly','barely','scarcely','dont','cant','wont']);

function vaderScore(text) {
  const words    = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  let total      = 0;
  let count      = 0;
  let amplifier  = 1.0;

  for (let i = 0; i < words.length; i++) {
    const w       = words[i];
    const negated = i > 0 && (NEGATIONS.has(words[i-1]) ||
                   (i > 1 && NEGATIONS.has(words[i-2])));
    if (VADER_LEXICON[w] !== undefined) {
      let score = VADER_LEXICON[w] * amplifier;
      if (negated) score *= -0.74;
      total += score;
      count++;
      amplifier = 1.0;
    } else if (['very','extremely','highly','significantly'].includes(w)) {
      amplifier = 1.3;
    } else {
      amplifier = 1.0;
    }
  }
  if (count === 0) return 0;
  return Math.max(-1, Math.min(1, total / (count * 2.5)));
}

// ── Ponderi per sector ────────────────────────────────
// Fiecare sector defineste cat de mult conteaza fiecare din cei 7 factori
// Valori: 0.0 (irelevant) → 2.0 (extrem de relevant)
export const SECTOR_WEIGHTS = {
  'Technology': {
    geopolitic: 0.8, inflatie_dobanzi: 1.0, crize_financiare: 0.7,
    pandemii_sanatate: 0.3, tarife_comerciale: 1.2, alegeri_politice: 1.5,
    stiri_companie: 2.0,
    emoji: '💻', label: 'Technology',
  },
  'Energy': {
    geopolitic: 2.0, inflatie_dobanzi: 1.2, crize_financiare: 0.8,
    pandemii_sanatate: 0.3, tarife_comerciale: 1.5, alegeri_politice: 1.3,
    stiri_companie: 1.5,
    emoji: '⚡', label: 'Energy',
  },
  'Financial Services': {
    geopolitic: 0.8, inflatie_dobanzi: 2.0, crize_financiare: 2.0,
    pandemii_sanatate: 0.4, tarife_comerciale: 0.7, alegeri_politice: 1.5,
    stiri_companie: 1.5,
    emoji: '🏦', label: 'Financial Services',
  },
  'Healthcare': {
    geopolitic: 0.4, inflatie_dobanzi: 0.7, crize_financiare: 0.5,
    pandemii_sanatate: 2.0, tarife_comerciale: 0.6, alegeri_politice: 1.8,
    stiri_companie: 1.8,
    emoji: '🏥', label: 'Healthcare',
  },
  'Consumer Cyclical': {
    geopolitic: 0.6, inflatie_dobanzi: 1.5, crize_financiare: 1.2,
    pandemii_sanatate: 0.8, tarife_comerciale: 1.3, alegeri_politice: 0.8,
    stiri_companie: 1.5,
    emoji: '🛍', label: 'Consumer Cyclical',
  },
  'Consumer Defensive': {
    geopolitic: 0.5, inflatie_dobanzi: 1.2, crize_financiare: 0.8,
    pandemii_sanatate: 1.0, tarife_comerciale: 1.0, alegeri_politice: 0.7,
    stiri_companie: 1.3,
    emoji: '🛒', label: 'Consumer Defensive',
  },
  'Industrials': {
    geopolitic: 1.2, inflatie_dobanzi: 1.0, crize_financiare: 0.9,
    pandemii_sanatate: 0.5, tarife_comerciale: 1.8, alegeri_politice: 1.0,
    stiri_companie: 1.2,
    emoji: '🏭', label: 'Industrials',
  },
  'Basic Materials': {
    geopolitic: 1.5, inflatie_dobanzi: 1.0, crize_financiare: 0.8,
    pandemii_sanatate: 0.3, tarife_comerciale: 1.8, alegeri_politice: 0.9,
    stiri_companie: 1.2,
    emoji: '⛏', label: 'Basic Materials',
  },
  'Real Estate': {
    geopolitic: 0.4, inflatie_dobanzi: 2.0, crize_financiare: 1.5,
    pandemii_sanatate: 0.5, tarife_comerciale: 0.4, alegeri_politice: 1.0,
    stiri_companie: 1.2,
    emoji: '🏠', label: 'Real Estate',
  },
  'Utilities': {
    geopolitic: 1.0, inflatie_dobanzi: 1.5, crize_financiare: 0.7,
    pandemii_sanatate: 0.3, tarife_comerciale: 0.5, alegeri_politice: 1.3,
    stiri_companie: 1.0,
    emoji: '💡', label: 'Utilities',
  },
  'Communication Services': {
    geopolitic: 0.7, inflatie_dobanzi: 0.8, crize_financiare: 0.7,
    pandemii_sanatate: 0.4, tarife_comerciale: 1.0, alegeri_politice: 1.5,
    stiri_companie: 2.0,
    emoji: '📡', label: 'Communication Services',
  },
  'Cryptocurrency': {
    geopolitic: 1.0, inflatie_dobanzi: 1.5, crize_financiare: 1.5,
    pandemii_sanatate: 0.2, tarife_comerciale: 0.5, alegeri_politice: 1.3,
    stiri_companie: 2.0,
    emoji: '₿', label: 'Cryptocurrency',
  },
  'Unknown': {
    geopolitic: 1.0, inflatie_dobanzi: 1.0, crize_financiare: 1.0,
    pandemii_sanatate: 1.0, tarife_comerciale: 1.0, alegeri_politice: 1.0,
    stiri_companie: 1.0,
    emoji: '📊', label: 'Unknown',
  },
};

// ── Fallback local pentru tickere frecvente ──────────
// Folosit cand Yahoo Finance nu returneaza assetProfile
// (tipic pentru .SW, .DE, .RO, .L, .AS prin proxy CORS)
const TICKER_SECTOR_MAP = {
  // US
  'AAPL':   { sector: 'Technology',             industry: 'Consumer Electronics' },
  'MSFT':   { sector: 'Technology',             industry: 'Software — Infrastructure' },
  'NVDA':   { sector: 'Technology',             industry: 'Semiconductors' },
  'MU':     { sector: 'Technology',             industry: 'Semiconductors' },
  'GOOGL':  { sector: 'Communication Services', industry: 'Internet Content & Information' },
  'META':   { sector: 'Communication Services', industry: 'Internet Content & Information' },
  'TSLA':   { sector: 'Consumer Cyclical',      industry: 'Auto Manufacturers' },
  'AMZN':   { sector: 'Consumer Cyclical',      industry: 'Internet Retail' },
  'RY':     { sector: 'Financial Services',     industry: 'Banks — Diversified' },
  'JPM':    { sector: 'Financial Services',     industry: 'Banks — Diversified' },
  'ENB':    { sector: 'Energy',                 industry: 'Oil & Gas Midstream' },
  'XOM':    { sector: 'Energy',                 industry: 'Oil & Gas Integrated' },
  // Swiss (.SW)
  'ABBN.SW':{ sector: 'Industrials',            industry: 'Specialty Industrial Machinery' },
  'ZURN.SW':{ sector: 'Financial Services',     industry: 'Insurance — Diversified' },
  'NESN.SW':{ sector: 'Consumer Defensive',     industry: 'Packaged Foods' },
  'SIKA.SW':{ sector: 'Basic Materials',        industry: 'Specialty Chemicals' },
  'ROG.SW': { sector: 'Healthcare',             industry: 'Drug Manufacturers — General' },
  'NOVN.SW':{ sector: 'Healthcare',             industry: 'Drug Manufacturers — General' },
  'UBSG.SW':{ sector: 'Financial Services',     industry: 'Banks — Diversified' },
  // German (.DE)
  'OMV.DE': { sector: 'Energy',                 industry: 'Oil & Gas Integrated' },
  'MUM.DE': { sector: 'Financial Services',     industry: 'Insurance — Reinsurance' },
  'SAP.DE': { sector: 'Technology',             industry: 'Software — Application' },
  'BMW.DE': { sector: 'Consumer Cyclical',      industry: 'Auto Manufacturers' },
  'SIE.DE': { sector: 'Industrials',            industry: 'Specialty Industrial Machinery' },
  // UK (.L)
  'BATS.L': { sector: 'Consumer Defensive',     industry: 'Tobacco' },
  'SHEL.L': { sector: 'Energy',                 industry: 'Oil & Gas Integrated' },
  'HSBA.L': { sector: 'Financial Services',     industry: 'Banks — Diversified' },
  // Netherlands (.AS)
  'APAM.AS':{ sector: 'Basic Materials',        industry: 'Steel' },
  'ASML.AS':{ sector: 'Technology',             industry: 'Semiconductor Equipment & Materials' },
  // Romania (.RO)
  'TLV.RO': { sector: 'Financial Services',     industry: 'Banks — Regional' },
  'SNP.RO': { sector: 'Energy',                 industry: 'Oil & Gas Integrated' },
  'BRD.RO': { sector: 'Financial Services',     industry: 'Banks — Regional' },
};

// ── Detectie sector din Yahoo Finance ────────────────
// Helper: fetch cu timeout ca sa nu atarne la nesfarsit
async function fetchWithTimeout(url, ms = 4000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSectorData(ticker) {
  // Crypto detection
  if (ticker.includes('-USD') || ticker.includes('-EUR') ||
      ticker.includes('-BTC') || ['BTC','ETH','BNB','SOL','XRP'].includes(ticker)) {
    return { sector: 'Cryptocurrency', industry: 'Cryptocurrency', weights: SECTOR_WEIGHTS['Cryptocurrency'] };
  }

  const upper = ticker.toUpperCase();

  // FAST PATH: daca tickerul e in map-ul local, returneaza imediat
  // (evita complet call-ul lent prin proxy CORS)
  if (TICKER_SECTOR_MAP[upper]) {
    const { sector, industry } = TICKER_SECTOR_MAP[upper];
    const weights = SECTOR_WEIGHTS[sector] || SECTOR_WEIGHTS['Unknown'];
    return { sector, industry, weights };
  }

  // Pentru tickere necunoscute: incearca Yahoo cu timeout scurt
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=assetProfile`;
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];

  for (const proxyUrl of proxies) {
    try {
      const r = await fetchWithTimeout(proxyUrl, 4000);
      if (!r.ok) continue;
      const data     = await r.json();
      const profile  = data?.quoteSummary?.result?.[0]?.assetProfile;
      const sector   = profile?.sector;
      const industry = profile?.industry;
      if (sector) {
        const weights = SECTOR_WEIGHTS[sector] || SECTOR_WEIGHTS['Unknown'];
        return { sector, industry: industry || sector, weights };
      }
    } catch (e) {
      console.warn('Sector fetch timeout/fail:', e.message);
    }
  }

  // Fallback final: Unknown
  return { sector: 'Unknown', industry: 'Unknown', weights: SECTOR_WEIGHTS['Unknown'] };
}

// ── Fetch VIX (indicele fricii) ───────────────────────
export async function fetchVIX() {
  try {
    const url   = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d';
    const proxy = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    const r     = await fetchWithTimeout(proxy, 4000);
    const data  = await r.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean);
    if (!closes || closes.length === 0) return { vix: null, vixLabel: 'N/A', vixImpact: 0 };

    const vix = closes[closes.length - 1];
    // VIX < 15 = piata calma, 15-25 = normal, 25-35 = stres, >35 = panica
    const vixLabel = vix < 15 ? '😴 Calm' : vix < 25 ? '😐 Normal' : vix < 35 ? '😟 Stres' : '🔥 Panica';
    // Impact pe sigma: VIX mare => sigma mai mare in simulare
    const vixImpact = vix > 25 ? (vix - 25) / 100 : vix < 15 ? -(15 - vix) / 200 : 0;
    return { vix: +vix.toFixed(2), vixLabel, vixImpact };
  } catch (e) {
    console.warn('VIX fetch failed:', e);
    return { vix: null, vixLabel: 'N/A', vixImpact: 0 };
  }
}

// ── Keywords pentru cei 7 factori ────────────────────
const FACTOR_KEYWORDS = {
  geopolitic:        ['war','conflict','sanction','nato','russia','ukraine','china',
                      'taiwan','military','geopolit','tension','invasion','nuclear','troops'],
  inflatie_dobanzi:  ['inflation','interest rate','fed','federal reserve','ecb','rate',
                      'cpi','monetary','recession','gdp','economy','yield','bond','powell'],
  crize_financiare:  ['bank','crash','crisis','bankruptcy','default','debt','credit',
                      'collapse','bailout','financial','bear market'],
  pandemii_sanatate: ['pandemic','virus','covid','disease','outbreak','health',
                      'vaccine','lockdown','epidemic'],
  tarife_comerciale: ['tariff','trade war','import','export','customs','wto',
                      'supply chain','embargo','trade deal'],
  alegeri_politice:  ['election','vote','president','congress','senate','government',
                      'policy','political','democrat','republican','regulation','law','parliament'],
  stiri_companie:    [],
};

function assignFactor(title, ticker) {
  const t         = title.toLowerCase();
  const tickerLow = ticker.toLowerCase().split('.')[0];
  if (t.includes(tickerLow)) return 'stiri_companie';
  for (const [factor, keywords] of Object.entries(FACTOR_KEYWORDS)) {
    if (factor === 'stiri_companie') continue;
    if (keywords.some(kw => t.includes(kw))) return factor;
  }
  return 'stiri_companie';
}

// ── Descarcare stiri (toate PARALEL, cu timeout) ─────
async function fetchRss(url, sursa, limit = 25) {
  const titluri = [];
  try {
    const proxy = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
    const r     = await fetchWithTimeout(proxy, 6000);
    if (!r.ok) return titluri;
    const data  = await r.json();
    (data.items || []).slice(0, limit).forEach(item => {
      if (item.title) titluri.push({ titlu: item.title, sursa });
    });
  } catch (e) { console.warn(`${sursa} timeout/fail:`, e.message); }
  return titluri;
}

async function fetchYahooNews(ticker) {
  const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
  return fetchRss(rssUrl, 'Yahoo Finance', 50);
}

async function fetchReutersNews() {
  const feeds = [
    ['https://feeds.reuters.com/reuters/businessNews',  'Reuters Business'],
    ['https://feeds.reuters.com/reuters/financialNews', 'Reuters Finance'],
  ];
  // Rulam feed-urile in paralel
  const results = await Promise.all(feeds.map(([u, s]) => fetchRss(u, s, 25)));
  return results.flat();
}

async function fetchGoogleNews(ticker, companyName) {
  const queries = [ticker, `${ticker} stock`];
  if (companyName && companyName !== ticker) queries.push(companyName.split(' ')[0]);
  // Rulam query-urile in paralel
  const results = await Promise.all(queries.map(q => {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    return fetchRss(rssUrl, 'Google News', 20);
  }));
  return results.flat();
}

// ── Analiza principala ────────────────────────────────
export async function analyzeSentiment(ticker, companyName, onProgress) {
  onProgress?.('Descarc sector, VIX si stiri (paralel)...');
  // Rulam toate fetch-urile simultan, nu secvential
  const [
    { sector, industry, weights },
    vixData,
    yahooNews,
    reutersNews,
    googleNews,
  ] = await Promise.all([
    fetchSectorData(ticker),
    fetchVIX(),
    fetchYahooNews(ticker),
    fetchReutersNews(),
    fetchGoogleNews(ticker, companyName),
  ]);

  const all = [...yahooNews, ...reutersNews, ...googleNews];

  // Deduplicare
  const seen  = new Set();
  const unice = all.filter(({ titlu }) => {
    const k = titlu.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  onProgress?.(`Analizez ${unice.length} stiri (sector: ${sector})...`);

  const FACTORS = ['geopolitic','inflatie_dobanzi','crize_financiare',
                   'pandemii_sanatate','tarife_comerciale','alegeri_politice','stiri_companie'];

  const buckets = {};
  FACTORS.forEach(f => buckets[f] = []);

  unice.forEach(({ titlu, sursa }) => {
    const factor = assignFactor(titlu, ticker);
    const score  = vaderScore(titlu);
    buckets[factor].push({ titlu, sursa, score });
  });

  const LABELS = {
    geopolitic:        '🌍 Geopolitic',
    inflatie_dobanzi:  '💵 Inflatie / Dobanzi',
    crize_financiare:  '🏦 Crize financiare',
    pandemii_sanatate: '🦠 Pandemii / Sanatate',
    tarife_comerciale: '📦 Tarife comerciale',
    alegeri_politice:  '🗳 Alegeri / Politica',
    stiri_companie:    '📰 Stiri companie',
  };

  const factoriResult = {};
  const weightedScores = [];
  let totalWeight      = 0;

  FACTORS.forEach(factor => {
    const items  = buckets[factor];
    const scor   = items.length > 0
      ? items.reduce((s, i) => s + i.score, 0) / items.length
      : 0;

    const w = weights[factor] ?? 1.0;
    weightedScores.push(scor * w);
    totalWeight += w;

    factoriResult[factor] = {
      scor:    +scor.toFixed(3),
      weight:  +w.toFixed(1),        // ponderea sectorului
      label:   LABELS[factor],
      impact:  scor > 0.1 ? 'bullish' : scor < -0.1 ? 'bearish' : 'neutru',
      count:   items.length,
      stiri:   items.slice(0, 5),
    };
  });

  // Scor global ponderat pe sector
  const globalScore = totalWeight > 0
    ? weightedScores.reduce((a, b) => a + b, 0) / totalWeight
    : 0;

  const pozitive = FACTORS.filter(f => factoriResult[f].scor > 0.1).length;
  const negative = FACTORS.filter(f => factoriResult[f].scor < -0.1).length;
  const rawScores = FACTORS.map(f => factoriResult[f].scor);

  return {
    ticker,
    sector,
    industry,
    sectorWeights:    weights,
    vix:              vixData,
    factori:          factoriResult,
    sentimentGlobal:  +globalScore.toFixed(3),
    totalStiri:       unice.length,
    surse: {
      yahoo:   yahooNews.length,
      reuters: reutersNews.length,
      google:  googleNews.length,
    },
    scores:   rawScores,
    concluzie: globalScore > 0.1
      ? `Sentiment pozitiv (${pozitive}/7 factori bullish). Stiri favorabile pentru ${ticker} [${sector}].`
      : globalScore < -0.1
      ? `Sentiment negativ (${negative}/7 factori bearish). Precautie recomandata pentru ${ticker} [${sector}].`
      : `Sentiment neutru pentru ${ticker} [${sector}]. Factori mixti sau lipsa de stiri semnificative.`,
  };
}
