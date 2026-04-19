// ─────────────────────────────────────────────────────
//  ANALIZA SENTIMENT — fara API key
//  Surse: Yahoo Finance News + Reuters RSS + Google News
//  Algoritm: VADER-lite implementat in JavaScript
// ─────────────────────────────────────────────────────

// Lexicon VADER simplificat (cuvinte financiare + general)
const VADER_LEXICON = {
  // Pozitive
  'good':0.9,'great':1.5,'excellent':2.0,'strong':1.2,'growth':1.3,
  'profit':1.5,'gains':1.2,'bullish':1.8,'rally':1.4,'surge':1.6,
  'beat':1.3,'record':1.1,'boost':1.2,'rise':0.8,'soar':1.8,
  'upgrade':1.5,'outperform':1.6,'buy':0.8,'positive':1.0,
  'win':1.2,'recover':1.0,'rebound':1.2,'expand':1.0,'increase':0.8,
  'improve':1.0,'innovation':1.1,'launch':0.8,'deal':0.9,'partnership':0.9,
  'dividend':1.0,'revenue':0.5,'acquisition':0.7,'merger':0.5,
  // Negative
  'bad':-0.9,'worst':-1.8,'poor':-1.2,'weak':-1.1,'loss':-1.5,
  'bearish':-1.8,'crash':-2.0,'plunge':-1.8,'fall':-0.9,'drop':-1.0,
  'decline':-1.0,'miss':-1.3,'downgrade':-1.5,'sell':-0.8,'negative':-1.0,
  'concern':-0.8,'risk':-0.7,'warning':-1.2,'crisis':-1.8,'debt':-0.8,
  'layoff':-1.5,'bankrupt':-2.0,'fine':-1.2,'fraud':-1.8,'scandal':-1.8,
  'lawsuit':-1.2,'recall':-1.3,'halt':-1.0,'suspend':-1.0,'cut':-0.9,
  'war':-1.5,'conflict':-1.2,'sanction':-1.3,'tariff':-0.8,'inflation':-0.8,
  'recession':-1.5,'default':-1.8,'volatile':-0.6,'uncertainty':-0.8,
  // Amplificatori
  'very':1.3,'extremely':1.5,'highly':1.2,'significantly':1.2,
};

const NEGATIONS = new Set(['not','no','never','neither','nor','without',
                           'hardly','barely','scarcely','dont','cant','wont']);

function vaderScore(text) {
  const words  = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  let total    = 0;
  let count    = 0;
  let amplifier = 1.0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // Verifica negatie in ultimele 3 cuvinte
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
  // Normalizeaza la [-1, +1]
  return Math.max(-1, Math.min(1, total / (count * 2.5)));
}

// Keywords pentru cei 7 factori
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
  stiri_companie:    [], // se populeaza dinamic cu ticker-ul
};

function assignFactor(title, ticker) {
  const t = title.toLowerCase();
  const tickerLow = ticker.toLowerCase().split('.')[0];
  // stiri_companie: daca contine ticker-ul
  if (t.includes(tickerLow)) return 'stiri_companie';
  for (const [factor, keywords] of Object.entries(FACTOR_KEYWORDS)) {
    if (factor === 'stiri_companie') continue;
    if (keywords.some(kw => t.includes(kw))) return factor;
  }
  return 'stiri_companie';
}

// ── Descarcare stiri ──────────────────────────────────────────────────

async function fetchYahooNews(ticker) {
  const titluri = [];
  try {
    // Yahoo Finance RSS (public, fara API key)
    const rssUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
    const proxy  = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
    const r      = await fetch(proxy);
    const data   = await r.json();
    (data.items || []).forEach(item => {
      if (item.title) titluri.push({ titlu: item.title, sursa: 'Yahoo Finance' });
    });
  } catch (e) { console.warn('Yahoo RSS:', e); }
  return titluri;
}

async function fetchReutersNews() {
  const titluri = [];
  const feeds   = [
    { url: 'https://feeds.reuters.com/reuters/businessNews', sursa: 'Reuters Business' },
    { url: 'https://feeds.reuters.com/reuters/financialNews', sursa: 'Reuters Finance' },
  ];
  for (const { url, sursa } of feeds) {
    try {
      const proxy = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
      const r     = await fetch(proxy);
      const data  = await r.json();
      (data.items || []).slice(0, 25).forEach(item => {
        if (item.title) titluri.push({ titlu: item.title, sursa });
      });
    } catch (e) { console.warn(`${sursa}:`, e); }
  }
  return titluri;
}

async function fetchGoogleNews(ticker, companyName) {
  const titluri = [];
  const queries = [ticker, `${ticker} stock`];
  if (companyName && companyName !== ticker) {
    queries.push(companyName.split(' ')[0]);
  }
  for (const q of queries) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const proxy  = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
      const r      = await fetch(proxy);
      const data   = await r.json();
      (data.items || []).slice(0, 20).forEach(item => {
        if (item.title) titluri.push({ titlu: item.title, sursa: 'Google News' });
      });
    } catch (e) { console.warn('Google News:', e); }
  }
  return titluri;
}

// ── Analiza principala ────────────────────────────────────────────────

export async function analyzeSentiment(ticker, companyName, onProgress) {
  onProgress?.('Yahoo Finance...');
  const yahooNews   = await fetchYahooNews(ticker);

  onProgress?.('Reuters RSS...');
  const reutersNews = await fetchReutersNews();

  onProgress?.('Google News...');
  const googleNews  = await fetchGoogleNews(ticker, companyName);

  const all = [...yahooNews, ...reutersNews, ...googleNews];

  // Deduplicare
  const seen  = new Set();
  const unice = all.filter(({ titlu }) => {
    const k = titlu.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  onProgress?.(`Analizez ${unice.length} stiri...`);

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
  const allScores     = [];

  FACTORS.forEach(factor => {
    const items = buckets[factor];
    const scor  = items.length > 0
      ? items.reduce((s, i) => s + i.score, 0) / items.length
      : 0;

    allScores.push(scor);
    factoriResult[factor] = {
      scor:    +scor.toFixed(3),
      label:   LABELS[factor],
      impact:  scor > 0.1 ? 'bullish' : scor < -0.1 ? 'bearish' : 'neutru',
      count:   items.length,
      stiri:   items.slice(0, 5), // primele 5 stiri per factor
    };
  });

  const globalScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const pozitive    = allScores.filter(s => s > 0.1).length;
  const negative    = allScores.filter(s => s < -0.1).length;

  return {
    ticker,
    factori:          factoriResult,
    sentimentGlobal:  +globalScore.toFixed(3),
    totalStiri:       unice.length,
    surse: {
      yahoo:   yahooNews.length,
      reuters: reutersNews.length,
      google:  googleNews.length,
    },
    scores: allScores,
    concluzie: globalScore > 0.1
      ? `Sentiment pozitiv (${pozitive}/7 factori bullish). Stiri recente favorabile pentru ${ticker}.`
      : globalScore < -0.1
      ? `Sentiment negativ (${negative}/7 factori bearish). Precautie recomandata pentru ${ticker}.`
      : `Sentiment neutru pentru ${ticker}. Factori mixti sau lipsa de stiri semnificative.`,
  };
}
