// ai_synthesis.js

export function synthesizeAI(fund, tech) {
    const f = fund.score;
    const t = tech.score;

    const total = Math.round((f * 0.6) + (t * 0.4));

    let verdict = "HOLD";
    if (total >= 70) verdict = "BUY";
    else if (total <= 45) verdict = "AVOID";

    let confidence = "Moderată";
    if (total >= 75) confidence = "Ridicată";
    if (total <= 40) confidence = "Scăzută";

    return {
        total,
        verdict,
        confidence
    };
}
