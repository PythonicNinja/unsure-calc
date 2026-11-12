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
    formatNumber,
    computeHistogramBins,
    densityCurve,
    tokenizeStep,
    diffStepTokens,
    sortedValidSamples,
    percentileOfSorted,
    percentRankOfSorted,
    niceTicks,
    DEFAULT_SEED
} = calcCoreLib;

const FX_CACHE_KEY = "unsureCalcFx.v1";
const BIG_25_CURRENCIES = [
    "USD", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK",
    "PLN", "CZK", "HUF", "RON", "TRY", "CNY", "HKD", "SGD", "KRW", "INR",
    "MXN", "BRL", "ZAR", "AED"
];
const FX_SYMBOLS_QUERY = BIG_25_CURRENCIES.join(",");
const FX_ENDPOINTS = [
    `https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${FX_SYMBOLS_QUERY}`,
    `https://api.frankfurter.app/latest?base=EUR&symbols=${FX_SYMBOLS_QUERY}`,
];
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


function getQueryParam(name) {
    const query = window.location.search.startsWith("?")
        ? window.location.search.slice(1)
        : window.location.search;
    if (!query) return "";

    const pair = query
        .split("&")
        .map((chunk) => chunk.split("="))
        .find(([key]) => key && decodeURIComponent(key) === name);

    if (!pair || pair.length < 2) return "";
    const rawValue = pair.slice(1).join("=");
    try {
        return decodeURIComponent(rawValue);
    } catch (e) {
        console.error(`Failed to decode ${name} query parameter`, e);
        return rawValue;
    }
}

// Edits raw "&" chunks: URLSearchParams.toString() would turn spaces in expr into "+", which getQueryParam keeps literally
function withQueryParam(name, value) {
    const chunks = window.location.search
        .replace(/^\?/, "")
        .split("&")
        .filter((chunk) => chunk && chunk.split("=")[0] !== name);
    if (value !== null) chunks.push(`${name}=${encodeURIComponent(value)}`);
    return chunks.length ? `?${chunks.join("&")}` : window.location.pathname;
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

function buildFxRequestUrl(endpoint, forceRefresh) {
    if (!forceRefresh) return endpoint;
    const separator = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${separator}t=${Date.now()}`;
}

async function fetchLiveFxRates(today, forceRefresh = false) {
    let lastError = null;

    for (const endpoint of FX_ENDPOINTS) {
        try {
            const response = await fetch(buildFxRequestUrl(endpoint, forceRefresh), {
                cache: forceRefresh ? "reload" : "no-store",
            });
            if (!response.ok) {
                throw new Error(`${endpoint} HTTP ${response.status}`);
            }

            const payload = await response.json();
            const normalizedRates = normalizeBaseRates(payload?.rates);
            if (Object.keys(normalizedRates).length === 0) {
                throw new Error(`${endpoint} invalid FX payload`);
            }

            const rateDate = typeof payload?.date === "string" ? payload.date : today;
            return { source: "live", rates: normalizedRates, day: today, rateDate };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("All FX endpoints failed");
}

// Best synchronous guess at today's rates: in-memory state, then today's localStorage cache, then the fallback snapshot
function getProvisionalFxRates() {
    const today = getLocalDateStamp();
    if (fxState && fxState.day === today) return fxState.rates;
    const cached = readCachedFxData();
    if (cached && cached.day === today) return cached.rates;
    return normalizeBaseRates(FALLBACK_BASE_RATES);
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

function renderRateStatus(rateStatusDisplay, state, options = {}) {
    if (!rateStatusDisplay || !state) return;
    const onRefetch = typeof options.onRefetch === "function" ? options.onRefetch : null;
    const eurPln = state.rates?.PLN;
    const pairText = typeof eurPln === "number" ? `EUR/PLN ${eurPln.toFixed(4)}.` : "";
    const currencyCount = 1 + Object.keys(state.rates || {}).length;

    if (state.source === "live") {
        rateStatusDisplay.textContent = `Top ${currencyCount} currencies from Frankfurter (${state.rateDate}).`;
        return;
    }
    if (state.source === "cached") {
        rateStatusDisplay.textContent = `Top ${currencyCount} currencies cached ${state.rateDate}.`;
        if (onRefetch) {
            const refetchLink = document.createElement("a");
            refetchLink.href = "#";
            refetchLink.textContent = "Refetch";
            refetchLink.addEventListener("click", (event) => {
                event.preventDefault();
                onRefetch();
            });
            rateStatusDisplay.appendChild(document.createTextNode(" "));
            rateStatusDisplay.appendChild(refetchLink);
        }
        return;
    }
    rateStatusDisplay.textContent = `${pairText} Live rates unavailable, using fallback snapshot.`;
}

async function loadDailyFxRateState(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const today = getLocalDateStamp();
    if (!forceRefresh && fxState && fxState.day === today) return fxState;
    if (fxLoadPromise && !forceRefresh) return fxLoadPromise;
    if (fxLoadPromise && forceRefresh) {
        try {
            await fxLoadPromise;
        } catch (_error) {
            // Ignore prior in-flight failure and force a new fetch below.
        }
    }

    fxLoadPromise = (async () => {
        const cached = readCachedFxData();
        if (!forceRefresh && cached && cached.day === today) {
            fxState = {
                source: "cached",
                rates: cached.rates,
                day: cached.day,
                rateDate: cached.rateDate || cached.day,
            };
            return fxState;
        }

        try {
            const liveState = await fetchLiveFxRates(today, forceRefresh);
            const toCache = {
                rates: liveState.rates,
                day: today,
                rateDate: liveState.rateDate,
                fetchedAt: new Date().toISOString(),
            };
            writeCachedFxData(toCache);
            fxState = liveState;
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

const OPERATOR_GLYPHS = { "*": "\u00d7", "/": "\u00f7", "-": "\u2212" };
const NARROW_SPACE = "\u202f";
const COPY_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

// "8727.70" -> "8 727.70" (narrow no-break space); leaves exponent form alone
function groupDigits(numberText) {
    if (/e/i.test(numberText)) return numberText;
    const [whole, fraction] = numberText.split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NARROW_SPACE);
    return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function unitHtml(unit, className) {
    return unit ? `<span class="${className}">${escapeHtml(unit.toUpperCase())}</span>` : "";
}

// "8727.70eur" -> grouped number + unit badge
function amountHtml(text, unitClass) {
    const match = /^(-?[\d.]+(?:e[+-]\d+)?)([a-z]*)$/i.exec(text);
    if (!match) return escapeHtml(text);
    return `<span class="amt">${groupDigits(match[1])}${unitHtml(match[2], unitClass)}</span>`;
}

function stepTokenHtml(token, isNew) {
    let html;
    if (token.type === "number") {
        html = `<span class="tok-num">${groupDigits(token.value)}${unitHtml(token.unit, "tok-unit")}</span>`;
    } else if (token.type === "operator") {
        html = `<span class="tok-op">${OPERATOR_GLYPHS[token.text] || escapeHtml(token.text)}</span>`;
    } else if (token.type === "unit") {
        html = `<span class="tok-target">${escapeHtml(token.text.toUpperCase())}</span>`;
    } else {
        html = `<span class="tok-${token.type}">${escapeHtml(token.text)}</span>`;
    }
    return isNew ? `<mark class="tok-new">${html}</mark>` : html;
}

function stepExpressionHtml(tokens, changed) {
    return tokens.map((token, i) => stepTokenHtml(token, changed[i])).join(" ");
}

function stepDotHtml(index, lastIndex) {
    if (index === 0) return `<span class="step-dot" aria-hidden="true"></span>`;
    return `<span class="step-dot" aria-hidden="true">${index === lastIndex ? "=" : index}</span>`;
}

function stepRowHtml(tokens, changed, index, lastIndex) {
    const kind = index === 0 ? " is-input" : index === lastIndex ? " is-final" : "";
    const label = index === 0 ? "Input" : index === lastIndex ? "Result" : `Step ${index}`;
    return `<li class="step${kind}" style="--i:${index}">${stepDotHtml(index, lastIndex)}` +
        `<span class="sr-only">${label}: </span><span class="step-expr">${stepExpressionHtml(tokens, changed)}</span></li>`;
}

// Consecutive duplicates (e.g. a unary reduction that formats the same) add nothing to read
function dedupeSteps(steps) {
    return steps.filter((step, i) => i === 0 || step !== steps[i - 1]);
}

// Open state of the rendered <details> blocks, keyed by data-key, so re-renders keep what the reader opened
const openDetails = { steps: true, table: false };

function openAttr(key) {
    return openDetails[key] ? " open" : "";
}

// Entrance animations run only for calculations the reader starts; the first frame on load is final
function enteringClass(animate) {
    return animate ? " is-entering" : "";
}

// Stepper: input, each reduction (newly computed values highlighted), final value
function buildStepsHtml(rawSteps, animate) {
    const steps = dedupeSteps(Array.isArray(rawSteps) ? rawSteps : []);
    if (steps.length < 2) return "";
    const tokenized = steps.map(tokenizeStep);
    const lastIndex = steps.length - 1;
    const rows = tokenized.map((tokens, i) => {
        const changed = i === 0 ? tokens.map(() => false) : diffStepTokens(tokenized[i - 1], tokens);
        return stepRowHtml(tokens, changed, i, lastIndex);
    });
    const count = `${lastIndex} ${lastIndex === 1 ? "step" : "steps"}`;
    return `<details class="steps${enteringClass(animate)}" data-key="steps"${openAttr("steps")}>` +
        `<summary><span class="section-label">How it was worked out</span><span class="steps-count">${count}</span></summary>` +
        `<ol class="stepper">${rows.join("")}</ol></details>`;
}

// aria-live off: the band handles already announce their values, a live output would repeat every drag frame
function heroHtml(label, valueHtml, copyText) {
    const labelHtml = label ? `<div class="section-label">${label}</div>` : "";
    const copy = copyText
        ? `<button type="button" class="copy-btn" data-copy="${escapeHtml(copyText)}" aria-label="Copy ${escapeHtml(copyText)}">${COPY_ICON}<span class="copy-text">Copy</span></button>`
        : "";
    return `<div class="hero">${labelHtml}` +
        `<div class="hero-row"><output class="hero-value" aria-live="off">${valueHtml}</output>${copy}</div></div>`;
}

function statsHtml(stats) {
    if (stats.length === 0) return "";
    const items = stats.map(([label, valueHtml]) =>
        `<li class="stat"><span class="stat-label">${label}</span><span class="stat-value">${valueHtml}</span></li>`);
    return `<ul class="stats">${items.join("")}</ul>`;
}

function noteHtml(text) {
    return `<p class="result-note">${text}</p>`;
}

function errorHtml(message) {
    return `<div class="result-error" role="alert"><span class="error">${message}</span></div>`;
}

function emptyView(summaryHtml, hasError = false) {
    return { summaryHtml, histogramHtml: "", stepsHtml: "", hasError, simulation: null };
}

const EMPTY_VIEW = emptyView(noteHtml("Enter an expression to calculate."));

const HISTOGRAM_TRIM = 0.01; // the chart spans P1..P99 so a few outliers do not flatten the shape
const HISTOGRAM_BINS = 32; // rows of the table twin
const CURVE_WIDTH = 1000; // SVG units across the plot; heights run 0..100 from the peak down
const AXIS_TICKS = 5;
const COMPACT_UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"]];
const MIN_BAND_GAP = 1; // percentiles between the two band edges

// 5 -> "5", 2.5 -> "2.5"
function percentText(value) {
    return String(Number(value.toFixed(2)));
}

function shareText(fraction) {
    const percent = fraction * 100;
    if (percent === 0) return "0%";
    if (percent < 0.1) return "<0.1%";
    return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function plainAmount(value, unit) {
    return `${groupDigits(formatNumber(value))}${unit ? ` ${unit.toUpperCase()}` : ""}`;
}

function plainRange(low, high, unit) {
    return `${plainAmount(low, "")} ~ ${plainAmount(high, unit)}`;
}

function positionPercent(value, histogram) {
    const position = ((value - histogram.minVal) / (histogram.maxVal - histogram.minVal)) * 100;
    return Math.min(100, Math.max(0, position));
}

// Labels near an edge hang inward instead of centering past the plot
function edgeClass(position, margin) {
    if (position < margin) return " is-start";
    return position > 100 - margin ? " is-end" : "";
}

function binInBand(bin, band) {
    const center = (bin.start + bin.end) / 2;
    return center >= band.lowValue && center <= band.highValue;
}

// Share of all valid samples at or below each bin's upper edge (the P0..P1 tail included)
function cumulativeShares(histogram) {
    let running = histogram.belowCount;
    return histogram.bins.map((bin) => {
        running += bin.count;
        return running / histogram.validCount;
    });
}

// Density -> heights as a share of the tallest point (0..1); empty when there is nothing to draw
function curveShape(density) {
    const peak = Math.max(0, ...density);
    return peak > 0 ? density.map((value) => value / peak) : [];
}

function curvePoints(shape) {
    const last = shape.length - 1;
    return shape.map((height, i) => `${((i / last) * CURVE_WIDTH).toFixed(1)} ${(100 - height * 100).toFixed(2)}`);
}

// The area is drawn twice: tails, then the band clipped to its edges by paintBand(); the outline goes on top
function curveSvgHtml(shape, label) {
    const line = `M${curvePoints(shape).join("L")}`;
    const area = `${line}L${CURVE_WIDTH} 100L0 100Z`;
    return `<svg class="dist-curve" viewBox="0 0 ${CURVE_WIDTH} 100" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}">` +
        `<clipPath id="dist-band-clip"><rect class="dist-band-rect" x="0" y="0" width="0" height="100"/></clipPath>` +
        `<path class="dist-area" d="${area}"/><path class="dist-area is-band" d="${area}" clip-path="url(#dist-band-clip)"/>` +
        `<path class="dist-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
}

const CURSOR_HTML = '<span class="dist-cursor" hidden><span class="dist-cursor-dot"></span>' +
    '<span class="dist-tip"><strong></strong><span class="dist-tip-muted"></span></span></span>';

function meanMarkerHtml(chart) {
    const { histogram, unit } = chart;
    const left = positionPercent(histogram.sampleMean, histogram);
    return `<span class="dist-mean" style="left:${left.toFixed(2)}%">` +
        `<span class="dist-mean-label${edgeClass(left, 15)}">mean ${plainAmount(histogram.sampleMean, unit)}</span></span>`;
}

// Band edges are sliders on the chart itself: drag them, or focus one and use the arrow keys
function handleHtml(edge, label) {
    return `<span class="dist-handle is-${edge}" data-edge="${edge}" role="slider" tabindex="0" aria-label="${label}" ` +
        `aria-orientation="horizontal"><span class="dist-handle-tip"></span></span>`;
}

// Full numbers under a million, compact (1.25M) above; tiny values in exponent form
function formatTick(value, decimals) {
    const abs = Math.abs(value);
    const compact = COMPACT_UNITS.find(([size]) => abs >= size);
    if (compact) return `${Number((value / compact[0]).toPrecision(3))}${compact[1]}`;
    if (abs !== 0 && abs < 1e-6) return value.toExponential(1);
    return groupDigits(value.toFixed(decimals));
}

function axisHtml(histogram) {
    const { ticks, decimals } = niceTicks(histogram.minVal, histogram.maxVal, AXIS_TICKS);
    const crowded = ticks.length > 4;
    const items = ticks.map((tick, i) => {
        const left = positionPercent(tick, histogram);
        const alt = crowded && i % 2 === 1 ? " is-alt" : "";
        return `<span class="dist-tick${alt}${edgeClass(left, 6)}" style="left:${left.toFixed(2)}%">${formatTick(tick, decimals)}</span>`;
    });
    return `<div class="dist-axis" aria-hidden="true">${items.join("")}</div>`;
}

function captionHtml(chart) {
    const samples = groupDigits(String(chart.histogram.validCount));
    return `<figcaption class="dist-caption">` +
        `<span class="dist-legend"><span class="dist-key" aria-hidden="true"></span><span class="dist-band-label"></span>` +
        `<span class="dist-hint">drag the edges to adjust</span></span>` +
        `<span class="dist-legend"><span class="dist-key dist-key-mean" aria-hidden="true"></span>mean</span>` +
        `<span class="dist-caption-note"><span>smoothed from ${samples} samples</span> · <span>seed ${DEFAULT_SEED}</span> · ` +
        `<span>P1-P99 shown</span></span></figcaption>`;
}

// Table twin of the chart: every value the tooltips show, reachable without hovering
function tableHtml(chart) {
    const { histogram, cumulative, unit } = chart;
    const rows = histogram.bins.map((bin, i) =>
        `<tr><td>${plainRange(bin.start, bin.end, unit)}</td>` +
        `<td>${shareText(bin.count / histogram.validCount)}</td><td>${shareText(cumulative[i])}</td></tr>`);
    return `<details class="dist-table" data-key="table"${openAttr("table")}><summary>Show as table</summary>` +
        `<table><thead><tr><th scope="col">Outcome</th><th scope="col">Share</th><th scope="col">At or below</th></tr></thead>` +
        `<tbody>${rows.join("")}</tbody></table></details>`;
}

function chartLabel(chart) {
    const { histogram, unit } = chart;
    return `Smoothed distribution of ${histogram.validCount} simulated outcomes, mean ${plainAmount(histogram.sampleMean, unit)}.`;
}

// Smoothed density on a value axis: mean line, round ticks, crosshair readout, table twin.
// Band-neutral on purpose; paintBand() adds the band so dragging it never rebuilds the chart.
function buildDistributionHtml(simulation, animate) {
    const { histogram, shape, unit } = simulation;
    if (!histogram || shape.length === 0) return "";
    const chart = { histogram, unit, cumulative: cumulativeShares(histogram) };
    return `<figure class="dist${enteringClass(animate)}"><div class="dist-plot">${curveSvgHtml(shape, chartLabel(chart))}` +
        `${meanMarkerHtml(chart)}${CURSOR_HTML}${handleHtml("low", "Lower percentile")}${handleHtml("high", "Upper percentile")}</div>` +
        `${axisHtml(histogram)}${captionHtml(chart)}${tableHtml(chart)}</figure>`;
}

function paintHandle(handle, edge, resolved, simulation) {
    const isLow = edge === "low";
    const percent = isLow ? resolved.low : resolved.high;
    const value = isLow ? resolved.lowValue : resolved.highValue;
    const position = positionPercent(value, simulation.histogram);
    const text = `P${percentText(percent)} · ${plainAmount(value, simulation.unit)}`;
    handle.style.left = `${position.toFixed(2)}%`;
    handle.setAttribute("aria-valuemin", isLow ? "0" : percentText(resolved.low + MIN_BAND_GAP));
    handle.setAttribute("aria-valuemax", isLow ? percentText(resolved.high - MIN_BAND_GAP) : "100");
    handle.setAttribute("aria-valuenow", percentText(percent));
    handle.setAttribute("aria-valuetext", text);
    handle.firstElementChild.textContent = text;
    handle.firstElementChild.className = `dist-handle-tip${edgeClass(position, 12)}`;
}

// Paints the band onto the rendered chart in place (area clip, table emphasis, handles, legend)
function paintBand(container, resolved, simulation) {
    const figure = container.querySelector(".dist");
    if (!figure) return;
    const { bins } = simulation.histogram;
    const left = positionPercent(resolved.lowValue, simulation.histogram);
    const right = positionPercent(resolved.highValue, simulation.histogram);
    const clip = figure.querySelector(".dist-band-rect");
    clip.setAttribute("x", ((left / 100) * CURVE_WIDTH).toFixed(1));
    clip.setAttribute("width", (((right - left) / 100) * CURVE_WIDTH).toFixed(1));
    figure.querySelectorAll(".dist-table tbody tr").forEach((row, i) => row.classList.toggle("in-band", binInBand(bins[i], resolved)));
    paintHandle(figure.querySelector(".dist-handle.is-low"), "low", resolved, simulation);
    paintHandle(figure.querySelector(".dist-handle.is-high"), "high", resolved, simulation);
    figure.querySelector(".dist-band-label").textContent = `${resolved.coverage} likely range`;
}

// The crosshair snaps to the nearest curve point: hairline, a dot on the curve, the value and the share at or below it
function paintCursor(cursor, fraction, simulation) {
    const { histogram, shape, sorted, unit } = simulation;
    const last = shape.length - 1;
    const index = Math.round(fraction * last);
    const position = (index / last) * 100;
    const value = histogram.minVal + (index / last) * (histogram.maxVal - histogram.minVal);
    const tip = cursor.lastElementChild;
    cursor.hidden = false;
    cursor.style.left = `${position.toFixed(2)}%`;
    cursor.style.setProperty("--height", `${(shape[index] * 100).toFixed(2)}%`);
    tip.className = `dist-tip${edgeClass(position, 15)}`;
    tip.firstElementChild.textContent = plainAmount(value, unit);
    tip.lastElementChild.textContent = `${shareText(percentRankOfSorted(sorted, value) / 100)} at or below`;
}

// Mouse only: touch has no hover, and over a handle the handle's own tip shows instead
function cursorPlot(event) {
    if (event.pointerType !== "mouse" || event.target.closest(".dist-handle")) return null;
    return event.target.closest(".dist-plot");
}

// Crosshair at a pointer x, or hidden when there is none
function paintCursorAt(container, clientX, simulation) {
    const cursor = container.querySelector(".dist-cursor");
    if (!cursor) return;
    if (clientX === null || !simulation) {
        cursor.hidden = true;
        return;
    }
    const rect = container.querySelector(".dist-curve").getBoundingClientRect();
    paintCursor(cursor, Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)), simulation);
}

function formatAmount(value, unit) {
    return `${formatNumber(value)}${unit}`;
}

function rangeText(low, high, unit) {
    return `${formatNumber(low)}~${formatNumber(high)}${unit}`;
}

function rangeHtml(low, high, unit) {
    return `${amountHtml(formatNumber(low), "")} <span class="hero-sep">~</span> ${amountHtml(formatAmount(high, unit), "hero-unit")}`;
}

function exactStats(result, unit) {
    const unitClass = "stat-unit";
    return [
        ["Exact average", amountHtml(result.display ?? formatAmount(result.mean, unit), unitClass)],
        ["Exact range", `${amountHtml(formatNumber(result.min), "")} ~ ${amountHtml(formatAmount(result.max, unit), unitClass)}`],
    ];
}

function hasNaN(...values) {
    return values.some((value) => isNaN(value));
}

// Everything a band change needs, so moving the band never re-evaluates the expression
function buildSimulation(samples, unit, stats) {
    const sorted = sortedValidSamples(samples);
    const histogram = computeHistogramBins(sorted, { bins: HISTOGRAM_BINS, trim: HISTOGRAM_TRIM });
    const shape = histogram ? curveShape(densityCurve(sorted, histogram.minVal, histogram.maxVal)) : [];
    return { sorted, histogram, shape, unit, stats };
}

function resolveBand(simulation, band) {
    return {
        ...band,
        lowValue: percentileOfSorted(simulation.sorted, band.low),
        highValue: percentileOfSorted(simulation.sorted, band.high),
        coverage: `${percentText(band.high - band.low)}%`,
    };
}

function simulatedSummaryHtml(simulation, resolved) {
    const { unit, stats } = simulation;
    return heroHtml("", rangeHtml(resolved.lowValue, resolved.highValue, unit),
        rangeText(resolved.lowValue, resolved.highValue, unit)) + statsHtml(stats);
}

// Ranges: the simulated band (P5-P95 unless the reader picks another) is the headline, exact figures go into the chips.
// The band row above the hero is its label; the band edges on the chart are its input.
function buildSimulatedView(samples, unit, stats, stepsHtml, display) {
    const simulation = buildSimulation(samples, unit, stats);
    if (simulation.sorted.length === 0) {
        return { ...emptyView(errorHtml("Simulated result contains NaN/Infinity"), true), stepsHtml };
    }
    const summaryHtml = simulatedSummaryHtml(simulation, resolveBand(simulation, display.band));
    const histogramHtml = buildDistributionHtml(simulation, display.animate);
    return { summaryHtml, histogramHtml, stepsHtml, hasError: false, simulation };
}

function buildCurrencyView(evaluation, result, display) {
    const unit = evaluation.currency || "";
    const displayValue = result.display ?? formatAmount(result.mean, unit);
    const stepsHtml = buildStepsHtml(evaluation.steps, display.animate);
    if (isNaN(result.mean)) return { ...emptyView(errorHtml("Currency result contains NaN"), true), stepsHtml };
    if (!result.samples) {
        return { ...emptyView(heroHtml("Result", amountHtml(displayValue, "hero-unit"), displayValue)), stepsHtml };
    }
    return buildSimulatedView(result.samples, unit, exactStats(result, unit), stepsHtml, display);
}

function buildRangeView(result, display) {
    if (hasNaN(result.mean, result.min, result.max)) return emptyView(errorHtml("Exact result contains NaN"), true);
    if (!result.samples) {
        const value = formatNumber(result.mean);
        return emptyView(heroHtml("Result", amountHtml(value, "hero-unit"), value) +
            noteHtml("Exact number, no distribution to simulate."));
    }
    return buildSimulatedView(result.samples, "", exactStats(result, ""), "", display);
}

// Pure: (expression, rates, {band, animate}) -> {summaryHtml, histogramHtml, stepsHtml, hasError, simulation}; never throws
function evaluateView(expression, evaluationOptions, display) {
    if (!expression.trim()) return EMPTY_VIEW;
    try {
        const evaluation = evaluateExpressionWithSteps(expression, undefined, evaluationOptions);
        const result = evaluation?.result;
        if (!result) return emptyView("");
        return evaluation.isCurrencyExpression
            ? buildCurrencyView(evaluation, result, display)
            : buildRangeView(result, display);
    } catch (error) {
        console.error("Calculation Error:", error);
        return emptyView(errorHtml(`Error: ${escapeHtml(error.message)}`), true);
    }
}

function pushExpressionToUrl(expression) {
    window.history.pushState(null, "", withQueryParam("expr", expression));
}

const BAND_PARAM = "p";
const DEFAULT_BAND = { low: 5, high: 95 };
const BAND_PRESETS = [10, 25, 50, 80, 90, 95, 98]; // central coverage in %, centered on the median

function presetBand(coverage) {
    return { low: 50 - coverage / 2, high: 50 + coverage / 2 };
}

function presetButtonsHtml() {
    return BAND_PRESETS.map((coverage) => {
        const { low, high } = presetBand(coverage);
        return `<button type="button" class="band-preset" data-coverage="${coverage}" aria-pressed="false" ` +
            `aria-label="${coverage}% range, P${percentText(low)} to P${percentText(high)}">${coverage}%</button>`;
    }).join("");
}

function validBand(low, high) {
    const ok = Number.isFinite(low) && Number.isFinite(high) && low >= 0 && high <= 100 && high - low >= MIN_BAND_GAP;
    return ok ? { low, high } : null;
}

// "?p=10-90" -> {low: 10, high: 90}; anything else -> the default P5-P95
function readBandFromUrl() {
    const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(getQueryParam(BAND_PARAM));
    return (match && validBand(Number(match[1]), Number(match[2]))) || DEFAULT_BAND;
}

function sameBand(a, b) {
    return a.low === b.low && a.high === b.high;
}

function replaceBandInUrl(band) {
    const value = sameBand(band, DEFAULT_BAND) ? null : `${percentText(band.low)}-${percentText(band.high)}`;
    window.history.replaceState(null, "", withQueryParam(BAND_PARAM, value));
}

function getBandControls() {
    const row = document.getElementById("band-row");
    const label = document.getElementById("band-label");
    const percentiles = document.getElementById("band-percentiles");
    const presets = document.getElementById("band-presets");
    if (!row || !label || !percentiles || !presets) return null;
    presets.innerHTML = presetButtonsHtml();
    return { row, label, percentiles, presets };
}

function syncBandControls(controls, band) {
    controls.label.textContent = `${percentText(band.high - band.low)}% likely range`;
    controls.percentiles.textContent = `P${percentText(band.low)} ~ P${percentText(band.high)}`;
    for (const preset of controls.presets.querySelectorAll(".band-preset")) {
        const pressed = sameBand(presetBand(Number(preset.dataset.coverage)), band);
        preset.setAttribute("aria-pressed", String(pressed));
    }
}

// Moves one edge, keeping the other fixed and the two at least MIN_BAND_GAP apart
function moveBandEdge(band, edge, percent) {
    if (edge === "low") return { low: Math.min(Math.max(percent, 0), band.high - MIN_BAND_GAP), high: band.high };
    return { low: band.low, high: Math.max(Math.min(percent, 100), band.low + MIN_BAND_GAP) };
}

// Pointer x over the plot -> percentile of the samples at that value, snapped to half a percent
function percentAtPointer(clientX, rect, simulation) {
    const { minVal, maxVal } = simulation.histogram;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const percent = percentRankOfSorted(simulation.sorted, minVal + fraction * (maxVal - minVal));
    return Math.round(percent * 2) / 2;
}

const HANDLE_KEY_STEPS = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 };

// Slider keys -> target percentile for that edge; null for keys a slider leaves alone
function keyTargetPercent(key, current) {
    if (key in HANDLE_KEY_STEPS) return current + HANDLE_KEY_STEPS[key];
    if (key === "Home") return 0;
    if (key === "End") return 100;
    return null;
}

const HANDLE_OVERLAP_PX = 16;

// Stacked handles (a narrow band) cannot be told apart by hit-testing; the first drag direction decides
function handlesOverlap(plot) {
    const low = plot.querySelector(".dist-handle.is-low").getBoundingClientRect();
    const high = plot.querySelector(".dist-handle.is-high").getBoundingClientRect();
    return Math.abs(high.left - low.left) < HANDLE_OVERLAP_PX;
}

const renderedHtml = new WeakMap();

// innerHTML only when the markup changed, so unchanged parts keep their state and do not replay animations
function setHtml(element, html) {
    if (renderedHtml.get(element) === html) return;
    renderedHtml.set(element, html);
    element.innerHTML = html;
}

const COPIED_RESET_MS = 1500;

async function copyFromButton(button, statusDisplay) {
    try {
        await navigator.clipboard.writeText(button.dataset.copy);
    } catch (error) {
        console.warn("Clipboard write failed", error);
        return;
    }
    button.classList.add("is-copied");
    button.querySelector(".copy-text").textContent = "Copied";
    if (statusDisplay) statusDisplay.textContent = `Copied ${button.dataset.copy}`;
    setTimeout(() => {
        button.classList.remove("is-copied");
        button.querySelector(".copy-text").textContent = "Copy";
    }, COPIED_RESET_MS);
}

function handleResultClick(event, statusDisplay) {
    const button = event.target.closest(".copy-btn");
    if (button) copyFromButton(button, statusDisplay);
}

// <details> "toggle" does not bubble, so this listens in the capture phase
function rememberDetailsToggle(event) {
    const key = event.target.dataset?.key;
    if (key in openDetails) openDetails[key] = event.target.open;
}

const HISTORY_KEY = "unsureCalcHistory.v1";
const HISTORY_LIMIT = 30;

function isHistoryEntry(entry) {
    return typeof entry?.expr === "string" && entry.expr !== "" && Number.isFinite(entry.at);
}

// Newest first; [] when storage is blocked, empty or malformed
function readHistory() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter(isHistoryEntry).slice(0, HISTORY_LIMIT) : [];
    } catch (error) {
        console.warn("Unable to read history", error);
        return [];
    }
}

function writeHistory(entries) {
    try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
    } catch (error) {
        console.warn("Unable to save history", error);
    }
}

// One entry per expression: a repeat moves to the top with the new time
function addToHistory(entries, expr, at) {
    return [{ expr, at }, ...entries.filter((entry) => entry.expr !== expr)].slice(0, HISTORY_LIMIT);
}

function removeFromHistory(entries, expr) {
    return entries.filter((entry) => entry.expr !== expr);
}

// Case-insensitive substring match; an empty query keeps everything
function matchHistory(entries, query) {
    const needle = query.trim().toLowerCase();
    return needle ? entries.filter((entry) => entry.expr.toLowerCase().includes(needle)) : entries;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function relativeTime(at, now) {
    const age = now - at;
    if (age < MINUTE_MS) return "just now";
    if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)} min ago`;
    if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)} h ago`;
    if (age < 2 * DAY_MS) return "yesterday";
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Escaped text with the first match of `query` wrapped in <mark>
function highlightHtml(text, query) {
    const needle = query.trim().toLowerCase();
    const start = needle ? text.toLowerCase().indexOf(needle) : -1;
    if (start < 0) return escapeHtml(text);
    const end = start + needle.length;
    return `${escapeHtml(text.slice(0, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>${escapeHtml(text.slice(end))}`;
}

const REMOVE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function historyOptionId(index) {
    return `history-opt-${index}`;
}

function historyOptionHtml(entry, index, query, activeIndex, now) {
    const active = index === activeIndex;
    return `<li role="option" id="${historyOptionId(index)}" class="history-option${active ? " is-active" : ""}" ` +
        `aria-selected="${active}" data-index="${index}">` +
        `<span class="history-expr">${highlightHtml(entry.expr, query)}</span>` +
        `<time class="history-time" datetime="${new Date(entry.at).toISOString()}">${relativeTime(entry.at, now)}</time>` +
        `<span class="history-remove" data-remove="${index}" title="Remove from history">${REMOVE_ICON}</span></li>`;
}

// Arrow-key move through `count` options, wrapping at both ends; -1 means none is active
function stepIndex(active, delta, count) {
    if (count === 0) return -1;
    if (active < 0) return delta > 0 ? 0 : count - 1;
    return (active + delta + count) % count;
}

function getHistoryCombo() {
    const popup = document.getElementById("history-popup");
    const list = document.getElementById("history-list");
    const toggle = document.getElementById("history-toggle");
    return popup && list && toggle ? { popup, list, toggle } : null;
}

function setupBrowserHandlers() {
    const expressionInput = document.getElementById("expression");
    const calculateBtn = document.getElementById("calculateBtn");
    const resultSummaryDisplay = document.getElementById("result-summary");
    const resultHistogramDisplay = document.getElementById("result-histogram");
    const resultStepsDisplay = document.getElementById("result-steps");
    const copyStatusDisplay = document.getElementById("copy-status");
    const resultContainer = document.getElementById("result-container");
    const rateStatusDisplay = document.getElementById("rate-status");

    if (!expressionInput || !calculateBtn || !resultSummaryDisplay || !resultHistogramDisplay || !resultStepsDisplay || !resultContainer) {
        return;
    }

    const bandControls = getBandControls();
    let band = readBandFromUrl();
    let lastSimulation = null;
    let drag = null;
    let pendingBand = null;
    let frame = 0;
    let cursorX = null;
    let cursorFrame = 0;
    const combo = getHistoryCombo();
    let history = readHistory();
    let comboOpen = false;
    let comboQuery = "";
    let comboActive = -1;
    let comboMatches = [];
    if (bandControls) syncBandControls(bandControls, band);

    const expr = getQueryParam("expr");
    if (expr && expr !== "null") {
        expressionInput.value = expr;
    }

    function reset() {
        expressionInput.value = "";
        calculate();
        expressionInput.focus();
    }

    function renderRateStatusWithRefetch(state) {
        renderRateStatus(rateStatusDisplay, state, {
            onRefetch: handleRefetchRates,
        });
    }

    async function handleRefetchRates() {
        if (!rateStatusDisplay) return;
        rateStatusDisplay.textContent = "Refetching daily FX rates...";
        const state = await loadDailyFxRateState({ forceRefresh: true });
        renderRateStatusWithRefetch(state);
        if (isCurrencyLikeExpression(expressionInput.value || "")) {
            calculate();
        }
    }

    // Sampling is seeded, so a re-render with the same rates yields the same markup and setHtml skips it
    function renderEvaluation(expression, evaluationOptions, { skipIfError = false, animate = false } = {}) {
        const view = evaluateView(expression, evaluationOptions, { band, animate });
        if (skipIfError && view.hasError) return null;
        lastSimulation = view.simulation;
        if (bandControls) bandControls.row.classList.toggle("hidden", !view.simulation);
        setHtml(resultSummaryDisplay, view.summaryHtml);
        setHtml(resultHistogramDisplay, view.histogramHtml);
        setHtml(resultStepsDisplay, view.stepsHtml);
        if (view.simulation) paintBand(resultHistogramDisplay, resolveBand(view.simulation, band), view.simulation);
        resultContainer.classList.toggle("has-error", view.hasError);
        resultContainer.classList.remove("hidden");
        return view;
    }

    // Only expressions that evaluated cleanly are kept
    function rememberExpression(expression, view) {
        const expr = expression.trim();
        if (!expr || !view || view.hasError) return;
        saveHistory(addToHistory(history, expr, Date.now()));
    }

    function saveHistory(entries) {
        history = entries;
        writeHistory(history);
        renderCombo();
    }

    // History dropdown: an ARIA 1.2 combobox on the expression input, filtered by what is typed
    function renderCombo() {
        if (!combo) return;
        comboMatches = matchHistory(history, comboQuery);
        comboActive = Math.min(comboActive, comboMatches.length - 1);
        const visible = comboOpen && comboMatches.length > 0;
        combo.toggle.hidden = history.length === 0;
        combo.toggle.setAttribute("aria-expanded", String(visible));
        combo.popup.hidden = !visible;
        expressionInput.setAttribute("aria-expanded", String(visible));
        if (comboActive >= 0) expressionInput.setAttribute("aria-activedescendant", historyOptionId(comboActive));
        else expressionInput.removeAttribute("aria-activedescendant");
        if (!visible) return;
        const now = Date.now();
        setHtml(combo.list, comboMatches.map((entry, i) => historyOptionHtml(entry, i, comboQuery, comboActive, now)).join(""));
        combo.list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
    }

    function openCombo(query = "") {
        comboOpen = true;
        comboQuery = query;
        comboActive = -1;
        renderCombo();
    }

    function closeCombo() {
        if (!comboOpen) return;
        comboOpen = false;
        comboActive = -1;
        renderCombo();
    }

    function pickHistory(index, { blur = false } = {}) {
        const entry = comboMatches[index];
        if (!entry) return;
        expressionInput.value = entry.expr;
        closeCombo();
        if (blur) expressionInput.blur();
        calculate({ animate: true });
    }

    function removeHistory(index) {
        const entry = comboMatches[index];
        if (entry) saveHistory(removeFromHistory(history, entry.expr));
    }

    function moveActive(delta) {
        if (!comboOpen) {
            openCombo();
            comboActive = stepIndex(-1, delta, comboMatches.length);
        } else {
            comboActive = stepIndex(comboActive, delta, comboMatches.length);
        }
        renderCombo();
    }

    // Keys the combobox owns; everything else (including Enter with no option active) reaches the input
    function handleComboKey(event) {
        const active = comboOpen && comboActive >= 0;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (history.length === 0) return;
            event.preventDefault();
            moveActive(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter" && active) {
            event.preventDefault();
            pickHistory(comboActive);
        } else if (event.key === "Escape" && comboOpen) {
            event.preventDefault();
            closeCombo();
        } else if (event.key === "Delete" && event.shiftKey && active) {
            event.preventDefault();
            removeHistory(comboActive);
        } else if (event.key === "Enter" || event.key === "Tab") {
            closeCombo();
        }
    }

    // A mousedown inside the popup must not blur the input, or the popup closes before the click lands
    function keepInputFocus(event) {
        event.preventDefault();
    }

    function handleComboClick(event) {
        if (event.target.closest(".history-clear")) {
            saveHistory([]);
            closeCombo();
            return;
        }
        const remove = event.target.closest(".history-remove");
        if (remove) {
            removeHistory(Number(remove.dataset.remove));
            return;
        }
        const option = event.target.closest(".history-option");
        if (option) pickHistory(Number(option.dataset.index), { blur: true });
    }

    function handleComboHover(event) {
        const option = event.target.closest(".history-option");
        const index = option ? Number(option.dataset.index) : -1;
        if (index === comboActive || index < 0) return;
        comboActive = index;
        renderCombo();
    }

    function toggleCombo() {
        if (comboOpen) {
            closeCombo();
            return;
        }
        expressionInput.focus();
        openCombo();
    }

    // Another tab saved or cleared history
    function syncHistoryFromStorage(event) {
        if (event.key !== HISTORY_KEY && event.key !== null) return;
        history = readHistory();
        renderCombo();
    }

    // A band change repaints from the last simulation: no re-evaluation, no pushState, no chart rebuild
    function applyBand(nextBand, { updateUrl = true } = {}) {
        band = nextBand;
        if (bandControls) syncBandControls(bandControls, band);
        if (updateUrl) replaceBandInUrl(band);
        if (!lastSimulation) return;
        const resolved = resolveBand(lastSimulation, band);
        setHtml(resultSummaryDisplay, simulatedSummaryHtml(lastSimulation, resolved));
        paintBand(resultHistogramDisplay, resolved, lastSimulation);
    }

    // Pointer drags repaint at most once per frame; the URL is written when the drag ends
    function scheduleBand(nextBand) {
        pendingBand = nextBand;
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            applyBand(pendingBand, { updateUrl: false });
        });
    }

    // The crosshair repaints at most once per frame and stays hidden while a band edge is dragged
    function scheduleCursor(event) {
        cursorX = !drag && cursorPlot(event) ? event.clientX : null;
        if (!cursorFrame) cursorFrame = requestAnimationFrame(flushCursor);
    }

    function flushCursor() {
        cursorFrame = 0;
        paintCursorAt(resultHistogramDisplay, cursorX, lastSimulation);
    }

    function handleBandPreset(event) {
        const preset = event.target.closest(".band-preset");
        if (preset) applyBand(presetBand(Number(preset.dataset.coverage)));
    }

    // Capture goes on the persistent container, so the drag survives a chart re-render (e.g. live FX rates)
    function startHandleDrag(event) {
        const handle = event.target.closest(".dist-handle");
        if (!handle || !lastSimulation || event.button > 0) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        const plot = handle.parentElement;
        drag = {
            pointerId: event.pointerId,
            edge: handle.dataset.edge,
            handle,
            startX: event.clientX,
            ambiguous: handlesOverlap(plot),
            rect: plot.querySelector(".dist-curve").getBoundingClientRect(),
        };
        handle.classList.add("is-active");
        resultHistogramDisplay.classList.add("is-dragging");
        resultHistogramDisplay.setPointerCapture(event.pointerId);
    }

    function moveHandleDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (drag.ambiguous) {
            if (Math.abs(event.clientX - drag.startX) < 3) return;
            drag.edge = event.clientX < drag.startX ? "low" : "high";
            drag.ambiguous = false;
        }
        scheduleBand(moveBandEdge(pendingBand || band, drag.edge, percentAtPointer(event.clientX, drag.rect, lastSimulation)));
    }

    function endHandleDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.handle.classList.remove("is-active");
        drag = null;
        resultHistogramDisplay.classList.remove("is-dragging");
        if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
            applyBand(pendingBand, { updateUrl: false });
        }
        pendingBand = null;
        replaceBandInUrl(band);
    }

    function handleHandleKey(event) {
        const handle = event.target.closest(".dist-handle");
        if (!handle || !lastSimulation) return;
        const edge = handle.dataset.edge;
        const target = keyTargetPercent(event.key, edge === "low" ? band.low : band.high);
        if (target === null) return;
        event.preventDefault();
        applyBand(moveBandEdge(band, edge, target));
    }

    // Non-currency expressions render synchronously (before the first paint on initial load)
    async function calculate({ animate = false } = {}) {
        const expression = expressionInput.value;
        if (expression) pushExpressionToUrl(expression);

        if (!isCurrencyLikeExpression(expression)) {
            const view = renderEvaluation(expression, {}, { animate });
            rememberExpression(expression, view);
            return;
        }

        // Provisional render with today's cached (or fallback) rates keeps the result box in the first frame;
        // the live rates re-render the same layout, so nothing moves.
        renderEvaluation(expression, buildCurrencyRateOptions(getProvisionalFxRates()), { skipIfError: true, animate });
        const state = await loadDailyFxRateState();
        renderRateStatusWithRefetch(state);
        const view = renderEvaluation(expression, buildCurrencyRateOptions(state.rates), { animate });
        rememberExpression(expression, view);
    }

    calculateBtn.addEventListener("click", () => calculate({ animate: true }));
    resultContainer.addEventListener("click", (event) => handleResultClick(event, copyStatusDisplay));
    resultContainer.addEventListener("toggle", rememberDetailsToggle, true);
    resultHistogramDisplay.addEventListener("pointerdown", startHandleDrag);
    resultHistogramDisplay.addEventListener("pointermove", moveHandleDrag);
    resultHistogramDisplay.addEventListener("pointermove", scheduleCursor);
    resultHistogramDisplay.addEventListener("pointerleave", scheduleCursor);
    resultHistogramDisplay.addEventListener("pointerup", endHandleDrag);
    resultHistogramDisplay.addEventListener("pointercancel", endHandleDrag);
    resultHistogramDisplay.addEventListener("lostpointercapture", endHandleDrag);
    resultHistogramDisplay.addEventListener("keydown", handleHandleKey);
    if (bandControls) bandControls.row.addEventListener("click", handleBandPreset);
    expressionInput.addEventListener("keypress", (event) => {
        if (event.key === "Enter") calculate({ animate: true });
    });
    expressionInput.addEventListener("keydown", handleComboKey);
    expressionInput.addEventListener("focus", () => openCombo());
    expressionInput.addEventListener("click", () => { if (!comboOpen) openCombo(); });
    expressionInput.addEventListener("input", () => openCombo(expressionInput.value));
    expressionInput.addEventListener("blur", closeCombo);
    if (combo) {
        combo.popup.addEventListener("mousedown", keepInputFocus);
        combo.popup.addEventListener("click", handleComboClick);
        combo.popup.addEventListener("pointermove", handleComboHover);
        combo.toggle.addEventListener("mousedown", keepInputFocus);
        combo.toggle.addEventListener("click", toggleCombo);
    }
    window.addEventListener("storage", syncHistoryFromStorage);
    renderCombo();
    document.querySelector('h1')?.addEventListener('click', reset);

    if (!expressionInput.value) {
        expressionInput.value = "7 ~ 10 * 17~23 * 1~10eur to pln";
    }

    loadDailyFxRateState()
        .then((state) => renderRateStatusWithRefetch(state))
        .catch(() => renderRateStatusWithRefetch({
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

// Run in browser. Deferred scripts execute with the DOM parsed but before DOMContentLoaded;
// rendering right away keeps the result inside the render-blocked first frame (see index.html).
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupBrowserHandlers);
} else {
    setupBrowserHandlers();
}
})();
