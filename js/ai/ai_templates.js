// ai_templates.js

export function generateSummary(fund, tech, syn) {
    return {
        headline: `${syn.verdict} — scor ${syn.total}/100 (${syn.confidence})`,
        fundamentals: [
            `DCF: ${fund.verdict}`,
            `Scor fundamental: ${fund.score}/100`
        ],
        technicals: [
            `Trend: ${tech.trend}`,
            `Scor tehnic: ${tech.score}/100`
        ],
        conclusion: [
            `Profil risc-randament: favorabil`,
            `Fundamentale puternice, tehnic în îmbunătățire`
        ]
    };
}
