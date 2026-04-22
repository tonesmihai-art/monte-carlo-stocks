// =========================
// CONFIG
// =========================

const MY_PROXY = "https://monte-carlo-proxy.onrender.com";

async function proxyFetch(url) {
    const finalUrl = `${MY_PROXY}/proxy?url=${encodeURIComponent(url)}`;

    try {
        const r = await fetch(finalUrl);

        if (!r.ok) {
            throw new Error(`Proxy HTTP ${r.status}`);
        }

        // Yahoo uneori trimite HTML → încearcă JSON, altfel text
        const text = await r.text();
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }

    } catch (err) {
        console.error("[Proxy ERROR]", err);
        throw new Error("Proxy fetch failed");
    }
}

// =========================
// YAHOO FINANCE
// =========================

async function fetchYahooQuote(ticker) {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
    return await proxyFetch(url);
}

async function fetchYahooKeyStatistics(ticker) {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics`;
    return await proxyFetch(url);
}

async function fetchYahooFinancials(ticker) {
    const url = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${ticker}?symbol=${ticker}&type=financials`;
    return await proxyFetch(url);
}

// =========================
// FINANCIAL MODELING PREP
// =========================

const FMP_KEY = "U6KIewb4btX6jwjbChgY49mZxVHI30mG"; // pune cheia ta reală

async function fetchFMPQuote(ticker) {
    const url = `https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_KEY}`;
    return await proxyFetch(url);
}

async function fetchFMPKeyMetrics(ticker) {
    const url = `https://financialmodelingprep.com/api/v3/key-metrics/${ticker}?apikey=${FMP_KEY}`;
    return await proxyFetch(url);
}

async function fetchFMPBalanceSheet(ticker) {
    const url = `https://financialmodelingprep.com/api/v3/balance-sheet-statement/${ticker}?apikey=${FMP_KEY}`;
    return await proxyFetch(url);
}

// =========================
// SEC EDGAR
// =========================

async function fetchSECCompanyFacts(cik) {
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    return await proxyFetch(url);
}

// =========================
// VALUATION PANEL
// =========================

async function fetchValuationFundamentals(ticker) {
    try {
        const quote = await fetchYahooQuote(ticker);
        const stats = await fetchYahooKeyStatistics(ticker);
        const fin = await fetchYahooFinancials(ticker);

        return { quote, stats, fin };
    } catch (err) {
        console.error("Val fetch error:", err);
        throw new Error("Date indisponibile");
    }
}

// =========================
// MONTE CARLO SIMULATION
// =========================

function runMonteCarloSimulation(params) {
    const { startPrice, mu, sigma, steps, iterations } = params;

    const results = [];

    for (let i = 0; i < iterations; i++) {
        let price = startPrice;

        for (let s = 0; s < steps; s++) {
            const rnd = Math.random();
            const shock = mu + sigma * rnd;
            price *= 1 + shock;
        }

        results.push(price);
    }

    return results;
}

// =========================
// EXPORT
// =========================

window.API = {
    fetchYahooQuote,
    fetchYahooKeyStatistics,
    fetchYahooFinancials,
    fetchFMPQuote,
    fetchFMPKeyMetrics,
    fetchFMPBalanceSheet,
    fetchSECCompanyFacts,
    fetchValuationFundamentals,
    runMonteCarloSimulation
};
