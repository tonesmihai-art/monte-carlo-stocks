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
export async function fetchSectorData(ticker) {
  // Crypto detection
  if (ticker.includes('-USD') || ticker.includes('-EUR') ||
      ticker.includes('-BTC') || ['BTC','ETH','BNB','SOL','XRP'].includes(ticker)) {
    return { sector: 'Cryptocurrency', industry: 'Cryptocurrency', weights: SECTOR_WEIGHTS['Cryptocurrency'] };
  }

  // Incearca Yahoo Finance (cu doua proxy-uri de rezerva)
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=assetProfile`;
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];

  for (const proxyUrl of proxies) {
    try {
      const r = await fetch(proxyUrl);
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
      console.warn('Sector fetch failed via proxy:', e);
    }
  }

  // Fallback 1: map local pentru tickere cunoscute
  const upper = ticker.toUpperCase();
  if (TICKER_SECTOR_MAP[upper]) {
    const { sector, industry } = TICKER_SECTOR_MAP[upper];
    const weights = SECTOR_WEIGHTS[sector] || SECTOR_WEIGHTS['Unknown'];
    console.info(`Sector din map local pentru ${upper}: ${sector}`);
    return { sector, industry, weights };
  }

  // Fallback 2: Unknown
  return { sector: 'Unknown', industry: 'Unknown', weights: SECTOR_WEIGHTS['Unknown'] };
}
