// ── 3. Sector + VIX (independent de sentiment) ───────
setStatus('Detectez sector si VIX...');
let sectorWeights = null;
let vixData       = { vix: null, vixLabel: 'N/A', vixImpact: 0 };

try {
  const { sector, industry, weights } = await fetchSectorData(ticker);
  sectorWeights = weights;
  vixData       = await fetchVIX();
  renderSectorBadge(sector, industry, vixData, weights);
} catch (e) {
  console.warn('Sector/VIX error:', e);
}

// ── 4. Sentiment AI ──────────────────────────────────
let sentimentData = null;
let driftAdj = null, sigmaAdj = null;

if (doSentiment) {
  setStatus('Analizez sentiment (Yahoo + Reuters + Google News)...');
  try {
    sentimentData = await analyzeSentiment(ticker, name, msg => setStatus(msg));

    // Suprascrie sectorWeights daca sentiment-ul le-a detectat mai bine
    if (sentimentData.sectorWeights) sectorWeights = sentimentData.sectorWeights;
    if (sentimentData.vix?.vix)      vixData       = sentimentData.vix;

    const scores = Object.values(sentimentData.factori).map(f => f.scor);
    const adj    = adjustParams(drift, sigma, scores, sectorWeights, vixData.vixImpact);
    driftAdj     = adj.driftAdj;
    sigmaAdj     = adj.sigmaAdj;

    $('sent-global').textContent = `${sentimentData.sentimentGlobal >= 0 ? '+' : ''}${sentimentData.sentimentGlobal.toFixed(3)}`;
    $('sent-global').style.color = sentimentData.sentimentGlobal > 0.1 ? '#66bb6a'
                                 : sentimentData.sentimentGlobal < -0.1 ? '#ef5350' : '#ffee58';
    $('sent-conclusion').textContent = sentimentData.concluzie;
    $('sent-sources').textContent =
      `Yahoo: ${sentimentData.surse.yahoo} | Reuters: ${sentimentData.surse.reuters} | Google: ${sentimentData.surse.google} | Total: ${sentimentData.totalStiri} stiri unice`;

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
