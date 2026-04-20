// ─────────────────────────────────────────────────────
//  MONTE CARLO — Geometric Brownian Motion in JavaScript
//  pret_nou = pret_vechi * exp(drift + sigma * Z)
// ─────────────────────────────────────────────────────

const NUM_SIMS = 50_000;

// Box-Muller: generam numere aleatoare cu distributie normala
function randNormal() {
  let u, v;
  do { u = Math.random(); } while (u === 0);
  do { v = Math.random(); } while (v === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Calculeaza drift si sigma din preturile istorice
export function calcParams(closes) {
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  const n    = logReturns.length;
  const mean = logReturns.reduce((a, b) => a + b, 0) / n;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const sigma = Math.sqrt(variance);
  const drift = mean - variance / 2;
  return { drift, sigma, mean, variance };
}

// Ruleaza NUM_SIMS simulari GBM pentru 'days' zile
// Returneaza matrice [days+1][NUM_SIMS]
export function simulate(currentPrice, drift, sigma, days,
                          driftAdj = null, sigmaAdj = null) {
  const d  = driftAdj  ?? drift;
  const s  = sigmaAdj  ?? sigma;
  const matrix = new Float64Array((days + 1) * NUM_SIMS);

  // Ziua 0 = pretul curent
  for (let sim = 0; sim < NUM_SIMS; sim++) {
    matrix[sim] = currentPrice;
  }

  for (let day = 1; day <= days; day++) {
    const offset     = day * NUM_SIMS;
    const prevOffset = (day - 1) * NUM_SIMS;
    for (let sim = 0; sim < NUM_SIMS; sim++) {
      const z = randNormal();
      matrix[offset + sim] = matrix[prevOffset + sim] * Math.exp(d + s * z);
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
  const finals  = getFinalPrices(matrix, days);
  const sorted  = Float64Array.from(finals).sort();
  const n       = sorted.length;
  const mean    = finals.reduce((a, b) => a + b, 0) / n;

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

// Ajustare parametri GBM pe baza sentiment scores + sector weights + VIX
export function adjustParams(drift, sigma, sentimentScores, sectorWeights = null, vixImpact = 0) {
  if (!sentimentScores || sentimentScores.length === 0) {
    return { driftAdj: drift, sigmaAdj: sigma };
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

  // Drift: sentiment pozitiv ponderat pe sector creste drift-ul
  const driftAdj = drift + avg * 0.0002;

  // Sigma: sentiment extrem + VIX ridicat = volatilitate mai mare
  const sigmaAdj = sigma * (1 + absAvg * 0.3 + vixImpact);

  return { driftAdj, sigmaAdj };
}

export { NUM_SIMS };
