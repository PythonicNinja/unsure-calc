// Browser UI for the UnSure calculator, reusing the shared core in calc-core.js
(function () {

const calcCoreLib = window.UnsureCalcCore;
if (!calcCoreLib) {
    throw new Error("calc-core.js not loaded; ensure script order in index.html");
}

const {
    tokenize,
    shuntingYard,
    evalRpn,
    evaluateExpression,
    evaluateExpressionWithSteps,
    getQuantiles,
    formatNumber,
    generateTextHistogram
} = calcCoreLib;

const FX_CACHE_KEY = "unsureCalcFx.v1";
const BIG_25_CURRENCIES = [
    "USD", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK",
    "PLN", "CZK", "HUF", "RON", "TRY", "CNY", "HKD", "SGD", "KRW", "INR",
    "MXN", "BRL", "ZAR", "AED"
];
const FX_ENDPOINT = `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${BIG_25_CURRENCIES.join(",")}`;
const FALLBACK_BASE_RATES = { PLN: 4.22 };
let fxLoadPromise = null;
let fxState = null;

function escapeHtml(raw) {
    if (raw === null || raw === undefined) return "";
    return String(raw)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function renderStepsHtml(steps) {
    if (!Array.isArray(steps) || steps.length === 0) return "";
    return steps
        .map((line, index) => `<div>${index}. ${escapeHtml(line)}</div>`)
        .join("");
}

function getExpressionFromQuery() {
    const query = window.location.search.startsWith("?")
        ? window.location.search.slice(1)
        : window.location.search;
    if (!query) return "";

    const pair = query
        .split("&")
        .map((chunk) => chunk.split("="))
        .find(([key]) => key && decodeURIComponent(key) === "expr");

    if (!pair || pair.length < 2) return "";
    const rawValue = pair.slice(1).join("=");
    try {
        return decodeURIComponent(rawValue);
    } catch (e) {
        console.error("Failed to decode expr query parameter", e);
        return rawValue;
    }
}

function getLocalDateStamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function readCachedFxData() {
    try {
        const raw = window.localStorage.getItem(FX_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        if (typeof parsed.day !== "string" || parsed.day.length < 8) return null;
        const normalizedRates = normalizeBaseRates(parsed.rates);
        if (Object.keys(normalizedRates).length === 0) return null;
        return {
            day: parsed.day,
            rateDate: typeof parsed.rateDate === "string" ? parsed.rateDate : parsed.day,
            rates: normalizedRates,
            fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
        };
    } catch (error) {
        console.warn("Unable to read cached FX data", error);
        return null;
    }
}

function writeCachedFxData(data) {
    try {
        window.localStorage.setItem(FX_CACHE_KEY, JSON.stringify(data));
    } catch (error) {
        console.warn("Unable to cache FX data", error);
    }
}

function normalizeBaseRates(rawRates) {
    const normalized = {};
    if (!rawRates || typeof rawRates !== "object") return normalized;

    for (const code of BIG_25_CURRENCIES) {
        const rate = rawRates[code] ?? rawRates[code.toLowerCase()];
        if (typeof rate === "number" && isFinite(rate) && rate > 0) {
            normalized[code] = rate;
        }
    }

    for (const [code, rate] of Object.entries(FALLBACK_BASE_RATES)) {
        if (!(code in normalized)) {
            normalized[code] = rate;
        }
    }

    return normalized;
}

function buildCurrencyRateOptions(baseRates) {
    const lowerRates = {};
    for (const [code, rate] of Object.entries(baseRates || {})) {
        if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) continue;
        lowerRates[code.toLowerCase()] = rate;
    }

    return {
        currencyRates: {
            eur: lowerRates
        }
    };
}

function isCurrencyLikeExpression(expression) {
    return /[a-z]/i.test(expression);
}

function renderRateStatus(rateStatusDisplay, state) {
    if (!rateStatusDisplay || !state) return;
    const eurPln = state.rates?.PLN;
    const pairText = typeof eurPln === "number" ? `EUR/PLN ${eurPln.toFixed(4)}.` : "";
    const currencyCount = 1 + Object.keys(state.rates || {}).length;

    if (state.source === "live") {
        rateStatusDisplay.textContent = `Top ${currencyCount} currencies from Frankfurter (${state.rateDate}).`;
        return;
    }
    if (state.source === "cached") {
        rateStatusDisplay.textContent = `Top ${currencyCount} currencies cached ${state.rateDate}.`;
        return;
    }
    rateStatusDisplay.textContent = `${pairText} Live rates unavailable, using fallback snapshot.`;
}

async function loadDailyFxRateState() {
    const today = getLocalDateStamp();
    if (fxState && fxState.day === today) return fxState;
    if (fxLoadPromise) return fxLoadPromise;

    fxLoadPromise = (async () => {
        const cached = readCachedFxData();
        if (cached && cached.day === today) {
            fxState = {
                source: "cached",
                rates: cached.rates,
                day: cached.day,
                rateDate: cached.rateDate || cached.day,
            };
            return fxState;
        }

        try {
            const response = await fetch(FX_ENDPOINT, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const payload = await response.json();
            const normalizedRates = normalizeBaseRates(payload?.rates);
            if (Object.keys(normalizedRates).length === 0) {
                throw new Error("Invalid FX payload");
            }

            const rateDate = typeof payload?.date === "string" ? payload.date : today;
            const toCache = {
                rates: normalizedRates,
                day: today,
                rateDate,
                fetchedAt: new Date().toISOString(),
            };
            writeCachedFxData(toCache);
            fxState = { source: "live", rates: normalizedRates, day: today, rateDate };
            return fxState;
        } catch (error) {
            if (cached) {
                fxState = {
                    source: "cached",
                    rates: cached.rates,
                    day: cached.day,
                    rateDate: cached.rateDate || cached.day,
                };
                return fxState;
            }

            fxState = {
                source: "fallback",
                rates: normalizeBaseRates(FALLBACK_BASE_RATES),
                day: today,
                rateDate: today,
                error: error?.message || "Unknown error",
            };
            return fxState;
        } finally {
            fxLoadPromise = null;
        }
    })();

    return fxLoadPromise;
}

function setupBrowserHandlers() {
    const expressionInput = document.getElementById("expression");
    const calculateBtn = document.getElementById("calculateBtn");
    const resultSummaryDisplay = document.getElementById("result-summary");
    const resultHistogramDisplay = document.getElementById("result-histogram");
    const resultContainer = document.getElementById("result-container");
    const rateStatusDisplay = document.getElementById("rate-status");

    if (!expressionInput || !calculateBtn || !resultSummaryDisplay || !resultHistogramDisplay || !resultContainer) {
        return;
    }

    const expr = getExpressionFromQuery();
    if (expr && expr !== "null") {
        expressionInput.value = expr;
    }

    function reset() {
        expressionInput.value = "";
        calculate();
        expressionInput.focus();
    }

    async function calculate() {
        const expression = expressionInput.value;
        resultSummaryDisplay.innerHTML = "<div>Calculating...</div>";
        resultHistogramDisplay.innerHTML = "";
        resultContainer.style.visibility = "hidden";
        resultContainer.classList.remove("hidden");
        resultContainer.classList.remove("border-red-600");
        resultSummaryDisplay.classList.remove("text-red-600");

        if (expression) {
            const params = new URLSearchParams(window.location.search);
            params.delete("expr");
            const encodedExpression = encodeURIComponent(expression);
            const rest = params.toString();
            const query = rest ? `?${rest}&expr=${encodedExpression}` : `?expr=${encodedExpression}`;
            window.history.pushState(null, "", query);
        }

        setTimeout(async () => {
            try {
                if (!expression.trim()) {
                    resultSummaryDisplay.innerHTML = "Enter an expression to calculate.";
                    resultHistogramDisplay.innerHTML = "";
                    resultContainer.style.visibility = "visible";
                    return;
                }

                let evaluationOptions = {};
                if (isCurrencyLikeExpression(expression)) {
                    const state = await loadDailyFxRateState();
                    renderRateStatus(rateStatusDisplay, state);
                    evaluationOptions = buildCurrencyRateOptions(state.rates);
                }

                const evaluation = evaluateExpressionWithSteps(expression, undefined, evaluationOptions);
                const result = evaluation?.result;

                if (!result) {
                    resultSummaryDisplay.innerHTML = "";
                    resultContainer.style.visibility = "visible";
                    return;
                }

                let summaryHtml = "";
                let hasError = false;

                if (evaluation.isCurrencyExpression) {
                    const displayValue = result.display ??
                        `${formatNumber(result.mean)}${evaluation.currency ? evaluation.currency : ""}`;
                    const currencySuffix = evaluation.currency ? evaluation.currency : "";

                    if (isNaN(result.mean)) {
                        summaryHtml += `<div><span class="text-red-600">Currency Result Contains NaN</span></div>`;
                        hasError = true;
                    } else {
                        summaryHtml += `<div>Final Result: ${escapeHtml(displayValue)}</div>`;
                    }

                    const stepsHtml = renderStepsHtml(evaluation.steps);
                    if (stepsHtml) {
                        summaryHtml += `<div class="mt-2">Steps:</div>`;
                        summaryHtml += `<div class="mt-1 text-sm">${stepsHtml}</div>`;
                    }

                    if (result.samples) {
                        const quantiles = getQuantiles(result.samples);
                        if (isNaN(quantiles.p05) || isNaN(quantiles.p95)) {
                            summaryHtml += `<div><span class="text-red-600">Simulated Result Contains NaN/Infinity</span></div>`;
                            hasError = true;
                        } else {
                            summaryHtml += `<div>Simulated Range (5%-95%): ${formatNumber(quantiles.p05)}${currencySuffix} ~ ${formatNumber(quantiles.p95)}${currencySuffix}</div>`;
                        }

                        const histogramLines = generateTextHistogram(result.samples);
                        resultHistogramDisplay.innerHTML = histogramLines.join("<br>");
                    } else {
                        resultHistogramDisplay.innerHTML = "";
                    }
                } else {
                    if (isNaN(result.mean) || isNaN(result.min) || isNaN(result.max)) {
                        summaryHtml += `<div><span class="text-red-600">Exact Result Contains NaN</span></div>`;
                        hasError = true;
                    } else {
                        summaryHtml += `<div>Exact Average: ${formatNumber(result.mean)}</div>`;
                        summaryHtml += `<div>Exact Range : ${formatNumber(result.min)} - ${formatNumber(result.max)}</div>`;
                    }

                    if (result.samples) {
                        const quantiles = getQuantiles(result.samples);
                        if (isNaN(quantiles.p05) || isNaN(quantiles.p95)) {
                            summaryHtml += `<div><span class="text-red-600">Simulated Result Contains NaN/Infinity</span></div>`;
                            hasError = true;
                        } else {
                            summaryHtml += `<div>Simulated Range (5%-95%): ${formatNumber(quantiles.p05)} ~ ${formatNumber(quantiles.p95)}</div>`;
                        }
                        const histogramLines = generateTextHistogram(result.samples);
                        resultHistogramDisplay.innerHTML = histogramLines.join("<br>");
                    } else {
                        resultHistogramDisplay.innerHTML = "";
                        summaryHtml += `<div class="mt-2">Result is an exact number, no distribution to simulate</div>`;
                    }
                }

                resultSummaryDisplay.innerHTML = summaryHtml;
                if (hasError) {
                    resultContainer.classList.add("border-red-600");
                }
            } catch (error) {
                console.error("Calculation Error:", error);
                resultSummaryDisplay.innerHTML = `<div><span class="text-red-600">Error: ${error.message}</span></div>`;
                resultContainer.classList.add("border-red-600");
                resultHistogramDisplay.innerHTML = "";
            }
            resultContainer.style.visibility = "visible";
        }, 10);
    }

    calculateBtn.addEventListener("click", calculate);
    expressionInput.addEventListener("keypress", (event) => {
        if (event.key === "Enter") calculate();
    });
    document.querySelector('h1')?.addEventListener('click', reset);

    if (!expressionInput.value) {
        expressionInput.value = "7~10 * 17~23";
    }

    loadDailyFxRateState()
        .then((state) => renderRateStatus(rateStatusDisplay, state))
        .catch(() => renderRateStatus(rateStatusDisplay, {
            source: "fallback",
            rates: normalizeBaseRates(FALLBACK_BASE_RATES),
            rateDate: getLocalDateStamp(),
        }));

    calculate();

    // Export to window for manual debugging
    window.unsureCalc = {
        tokenize,
        shuntingYard,
        evalRpn,
        evaluateExpression,
        reset,
        calculate,
    };
}

// Run in browser
document.addEventListener("DOMContentLoaded", () => {
  setupBrowserHandlers();
});
})();
