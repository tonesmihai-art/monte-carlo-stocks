// ─────────────────────────────────────────────────────
//  MONTE CARLO — Geometric Brownian Motion in JavaScript
//  pret_nou = pret_vechi * exp(drift + sigma * Z)
//  + Mean Reversion (Ornstein-Uhlenbeck) pe 50 de zile
// ─────────────────────────────────────────────────────

const NUM_SIMS = 30_000;

// Box-Muller: generam numere aleatoare cu distributie normala
function randNormal() {
  let u, v;
  do { u = Math.random(); } while (u === 0);
  do { v = Math.random(); } while (v === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Calculeaza drift, sigma si media pe 50 de zile din preturile istorice
export function calcParams(closes) {
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  const n        = logReturns.length;
  const mean     = logReturns.reduce((a, b) => a + b, 0) / n;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const sigma    = Math.sqrt(variance);
  const drift    = mean - variance / 2;

  // Media preturilor pe ultimele 30 de zile de tranzactionare
  const last50   = closes.slice(-50);
  const mean50   = last50.reduce((a, b) => a + b, 0) / last50.length; // redenumit intern dar compatibil cu restul codului

  // Cat de departe e pretul curent fata de media pe 30 zile (%)
  const currentPrice   = closes[closes.length - 1];
  const deviationPct   = ((currentPrice - mean50) / mean50) * 100;

  // Volume Trend — ultimele 10 zile vs media pe 50 de zile
  // Compara directia pretului cu directia volumului
  const volumeTrend = calcVolumeTrend(closes, volumes);

  return { drift, sigma, mean, variance, mean50, deviationPct, volumeTrend };
}


// Calculeaza trendul de volum pe ultimele 10 zile
// Returneaza un scor si un label descriptiv
function calcVolumeTrend(closes, volumes) {
  if (!volumes || volumes.length < 20) {
    return { score: 0, label: 'N/A', detail: 'date insuficiente' };
  }

  const n     = Math.min(10, closes.length - 1);
  const vols  = volumes.filter(v => v != null && v > 0);
  if (vols.length < 20) return { score: 0, label: 'N/A', detail: 'volum indisponibil' };

  const recentVols = vols.slice(-n);
  const avgVol30   = vols.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, vols.length);

  // Directia pretului in ultimele 10 zile
  const recentCloses  = closes.slice(-n);
  const priceUp       = recentCloses[recentCloses.length - 1] > recentCloses[0];
  const avgRecentVol  = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const volRatio      = avgRecentVol / avgVol30; // >1 = volum crescut, <1 = volum scazut

  let score = 0;
  let label = '';
  let detail = '';

  if (priceUp && volRatio > 1.1) {
    // Pret sus + volum sus = trend bullish confirmat
    score  = Math.min(0.3, (volRatio - 1) * 0.5);
    label  = `📈 Trend confirmat (+${((volRatio-1)*100).toFixed(0)}% vol)`;
    detail = 'bullish';
  } else if (priceUp && volRatio < 0.9) {
    // Pret sus + volum jos = trend slab, posibila inversare
    score  = -Math.min(0.15, (1 - volRatio) * 0.3);
    label  = `⚠️ Trend slab (vol -${((1-volRatio)*100).toFixed(0)}%)`;
    detail = 'divergenta bearish';
  } else if (!priceUp && volRatio > 1.1) {
    // Pret jos + volum sus = vanzare confirmata
    score  = -Math.min(0.3, (volRatio - 1) * 0.5);
    label  = `📉 Vanzare confirmata (+${((volRatio-1)*100).toFixed(0)}% vol)`;
    detail = 'bearish';
  } else if (!priceUp && volRatio < 0.9) {
    // Pret jos + volum jos = corectie slaba, posibila revenire
    score  = Math.min(0.1, (1 - volRatio) * 0.2);
    label  = `🔄 Corectie slaba (vol -${((1-volRatio)*100).toFixed(0)}%)`;
    detail = 'divergenta bullish';
  } else {
    score  = 0;
    label  = '➡️ Neutral';
    detail = 'neutru';
  }

  return { score: +score.toFixed(3), label, detail, volRatio: +volRatio.toFixed(2) };
}

// ── Simulare GBM cu Mean Reversion optional ───────────
// meanRevStrength: 0 = dezactivat, 0.05-0.15 = realist pentru actiuni
// mean50: tinta de revenire (media pe 50 zile)
export function simulate(currentPrice, drift, sigma, days,
                          driftAdj = null, sigmaAdj = null,
                          meanRevStrength = 0, mean50 = null) {
  const d      = driftAdj ?? drift;
  const s      = sigmaAdj ?? sigma;
  const target = mean50 ?? currentPrice; // daca nu avem mean50, nu revenim nicaieri
  const matrix = new Float64Array((days + 1) * NUM_SIMS);

  for (let sim = 0; sim < NUM_SIMS; sim++) {
    matrix[sim] = currentPrice;
  }

  for (let day = 1; day <= days; day++) {
    const offset     = day * NUM_SIMS;
    const prevOffset = (day - 1) * NUM_SIMS;
    for (let sim = 0; sim < NUM_SIMS; sim++) {
      const prevPrice = matrix[prevOffset + sim];
      const z         = randNormal();

      // Mean reversion: trage pretul spre mean50
      // Cu cat pretul e mai departe de medie, cu atat pull-ul e mai puternic
      const reversionPull = meanRevStrength > 0 && target > 0
        ? meanRevStrength * Math.log(target / prevPrice)
        : 0;

      matrix[offset + sim] = prevPrice * Math.exp(d + reversionPull + s * z);
    }
  }
  return matrix;
}

// Extrage un array de preturi finale (ultima zi)
export function getFinalPrices(matrix, days) {
  const offset = days * NUM_SIMS;
  const finals = new Float64Array(NUM_SIMS);
  for (let i = 0; i < NUM_SIMS; i++) finals[i] = matrix[offset + i];
  return finals;
}

// Calculeaza percentila dintr-un array
export function percentile(arr, p) {
  const sorted = Float64Array.from(arr).sort();
  const idx    = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

// Calculeaza toate statisticile
export function calcStats(matrix, days, currentPrice) {
  const finals = getFinalPrices(matrix, days);
  const sorted = Float64Array.from(finals).sort();
  const n      = sorted.length;
  const mean   = finals.reduce((a, b) => a + b, 0) / n;

  let probProfit = 0, probGain10 = 0, probLoss10 = 0;
  for (let i = 0; i < n; i++) {
    if (sorted[i] > currentPrice)         probProfit++;
    if (sorted[i] > currentPrice * 1.10)  probGain10++;
    if (sorted[i] < currentPrice * 0.90)  probLoss10++;
  }

  return {
    mean,
    median:     sorted[Math.floor(n * 0.5)],
    p10:        sorted[Math.floor(n * 0.10)],
    p25:        sorted[Math.floor(n * 0.25)],
    p75:        sorted[Math.floor(n * 0.75)],
    p90:        sorted[Math.floor(n * 0.90)],
    min:        sorted[0],
    max:        sorted[n - 1],
    probProfit: (probProfit / n) * 100,
    probGain10: (probGain10 / n) * 100,
    probLoss10: (probLoss10 / n) * 100,
    finals,
    sorted,
  };
}

// Percentile per zi (pentru graficul de traiectorii)
export function percentilesPerDay(matrix, days, pcts = [10, 50, 90]) {
  const result = {};
  pcts.forEach(p => result[p] = new Float64Array(days + 1));

  for (let day = 0; day <= days; day++) {
    const offset  = day * NUM_SIMS;
    const dayVals = new Float64Array(NUM_SIMS);
    for (let i = 0; i < NUM_SIMS; i++) dayVals[i] = matrix[offset + i];
    dayVals.sort();
    pcts.forEach(p => {
      result[p][day] = dayVals[Math.floor((p / 100) * (NUM_SIMS - 1))];
    });
  }
  return result;
}

// ── Ajustare parametri GBM ────────────────────────────
// Combina: sentiment ponderat pe sector + VIX + mean reversion
export function adjustParams(drift, sigma, sentimentScores,
                              sectorWeights = null, vixImpact = 0,
                              deviationPct = 0, volumeTrendScore = 0) {
  if (!sentimentScores || sentimentScores.length === 0) {
    return {
      driftAdj: drift, sigmaAdj: sigma,
      meanRevStrength: calcMeanRevStrength(deviationPct),
    };
  }

  const FACTOR_KEYS = ['geopolitic','inflatie_dobanzi','crize_financiare',
                       'pandemii_sanatate','tarife_comerciale','alegeri_politice','stiri_companie'];

  let weightedSum = 0;
  let totalWeight = 0;

  sentimentScores.forEach((score, i) => {
    const key = FACTOR_KEYS[i];
    const w   = sectorWeights?.[key] ?? 1.0;
    weightedSum += score * w;
    totalWeight += w;
  });

  const avg    = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const absAvg = Math.abs(avg);

  // Volume trend confirma sau slabeste drift-ul
  const driftAdj       = drift + avg * 0.0002 + volumeTrendScore * 0.0001;
  // Volum divergent (trend slab) => creste incertitudinea
  const volUncertainty = volumeTrendScore < 0 ? Math.abs(volumeTrendScore) * 0.15 : 0;
  const sigmaAdj       = sigma * (1 + absAvg * 0.3 + vixImpact + volUncertainty);
  const meanRevStrength = calcMeanRevStrength(deviationPct);

  return { driftAdj, sigmaAdj, meanRevStrength };
}

// Calculeaza forta de mean reversion in functie de deviatie fata de MA50
// Logica: cu cat pretul e mai departe de medie, cu atat revine mai puternic
// deviationPct > 0 = supracumparata, < 0 = suprainvatata
function calcMeanRevStrength(deviationPct) {
  const absDev = Math.abs(deviationPct);

  // Sub 5% deviere => practic fara mean reversion
  if (absDev < 5)  return 0.0;
  // 5-15% deviere => revenire slaba
  if (absDev < 15) return 0.03;
  // 15-30% deviere => revenire moderata
  if (absDev < 30) return 0.07;
  // Peste 30% deviere => revenire puternica
  return 0.12;
}

export { NUM_SIMS };
