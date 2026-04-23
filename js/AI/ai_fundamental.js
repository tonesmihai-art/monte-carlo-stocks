// ai_fundamental.js

export function calcFundamentalAI(data) {
    const {
        dcfUpside,          // ex: +0.36
        peActual,
        peCorect,
        fcfPerShare,
        leverage,           // datorii / capital
        growthFcf,          // crestere FCF %
        roe,
        roa,
        margin,
        sector
    } = data;

    // --- 1) Subapreciere ---
    let undervalueScore = 0;
    if (dcfUpside > 0.30) undervalueScore = 35;
    else if (dcfUpside > 0.15) undervalueScore = 25;
    else if (dcfUpside > 0.05) undervalueScore = 15;

    // --- 2) PE corect ---
    let peScore = 0;
    if (peActual < peCorect * 0.8) peScore = 20;
    else if (peActual < peCorect) peScore = 10;

    // --- 3) Profitabilitate ---
    let profitScore = 0;
    if (roe > 12) profitScore += 10;
    if (roa > 5) profitScore += 5;
    if (margin > 10) profitScore += 5;

    // --- 4) Leverage ---
    let leverageScore = 0;
    if (leverage < 1) leverageScore = 10;
    else if (leverage < 2) leverageScore = 5;

    // --- 5) Stabilitate FCF ---
    let fcfScore = 0;
    if (fcfPerShare > 0) fcfScore = 10;

    // --- 6) Growth ---
    let growthScore = 0;
    if (growthFcf > 5) growthScore = 10;

    // --- Total ---
    const total = undervalueScore + peScore + profitScore + leverageScore + fcfScore + growthScore;

    return {
        score: Math.min(100, total),
        verdict: total > 70 ? "Subapreciat" : total > 50 ? "Corect evaluat" : "Supraevaluat"
    };
}
