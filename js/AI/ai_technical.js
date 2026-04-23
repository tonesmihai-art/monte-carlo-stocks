// ai_technical.js

export function calcTechnicalAI(tech) {
    const {
        rsi,
        macdCross,
        ma20,
        ma50,
        ma200,
        price,
        atr,
        patternHL,      // higher lows
        patternHH,      // higher highs
        breakout,
        breakdown
    } = tech;

    let score = 0;

    // RSI
    if (rsi > 45 && rsi < 60) score += 10;
    if (rsi >= 60 && rsi <= 70) score += 15;

    // MACD
    if (macdCross === "bullish") score += 15;

    // MA alignment
    if (price > ma20) score += 10;
    if (ma20 > ma50) score += 10;
    if (ma50 > ma200) score += 10;

    // ATR (volatilitate)
    if (atr < price * 0.015) score += 10;

    // Pattern-uri
    if (patternHL) score += 10;
    if (patternHH) score += 10;
    if (breakout) score += 15;
    if (breakdown) score -= 20;

    return {
        score: Math.max(0, Math.min(100, score)),
        trend:
            score > 70 ? "Bullish" :
            score > 50 ? "Neutru → pozitiv" :
            score > 30 ? "Neutru" :
            "Bearish"
    };
}
