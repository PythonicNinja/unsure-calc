// Browser UI for the UnSure calculator, reusing the shared core in calc-core.js

try {
    const core = window.UnsureCalcCore;
} catch (e) {
    console.error(e)
}
if (!core) {
    throw new Error("calc-core.js not loaded; ensure script order in index.html");
}

try {
    const {
        tokenize,
        shuntingYard,
        evalRpn,
        evaluateExpression,
        getQuantiles,
        formatNumber,
        generateTextHistogram
    } = core;
} catch (e) {
    console.error(e)
}

function setupBrowserHandlers() {
    const expressionInput = document.getElementById("expression");
    const calculateBtn = document.getElementById("calculateBtn");
    const resultSummaryDisplay = document.getElementById("result-summary");
    const resultHistogramDisplay = document.getElementById("result-histogram");
    const resultContainer = document.getElementById("result-container");

    if (!expressionInput || !calculateBtn || !resultSummaryDisplay || !resultHistogramDisplay || !resultContainer) {
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const exprParam = params.get('expr');
    const expr = exprParam ? decodeURIComponent(exprParam) : "";
    if (expr && expr !== "null") {
        expressionInput.value = expr;
    }

    function reset() {
        expressionInput.value = "";
        calculate();
        expressionInput.focus();
    }

    function calculate() {
        const expression = expressionInput.value;
        resultSummaryDisplay.innerHTML = "<div>Calculating...</div>";
        resultHistogramDisplay.innerHTML = "";
        resultContainer.style.visibility = "hidden";
        resultContainer.classList.remove("hidden");
        resultContainer.classList.remove("border-red-600");
        resultSummaryDisplay.classList.remove("text-red-600");

        if (expression) {
            const params = new URLSearchParams();
            params.set('expr', encodeURIComponent(expression));
            window.history.pushState(null, '', `?${params.toString()}`);
        }

        setTimeout(() => {
            try {
                if (!expression.trim()) {
                    resultSummaryDisplay.innerHTML = "Enter an expression to calculate.";
                    resultHistogramDisplay.innerHTML = "";
                    resultContainer.style.visibility = "visible";
                    return;
                }
                const tokens = tokenize(expression);
                const rpn = shuntingYard(tokens);
                const result = evalRpn(rpn);

                if (!result) {
                    resultSummaryDisplay.innerHTML = "";
                    return;
                }

                let summaryHtml = "";
                let hasError = false;

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
