const test = require('node:test');
const assert = require('assert');
const {
    tokenize,
    shuntingYard,
    evaluateExpression,
    evaluateExpressionWithSteps,
    getQuantiles,
    generateTextHistogram,
    computeHistogramBins,
    tokenizeStep,
    diffStepTokens,
    sortedValidSamples,
    percentileOfSorted,
    percentRankOfSorted,
    niceTicks,
} = require('../calc-core');

test('Tokenizer keeps minus separate from number', () => {
    const tokens = tokenize('1-2');
    assert.deepStrictEqual(tokens, [1, '-', 2]);
});

test('Shunting yard parses leading negative number', () => {
    const rpn = shuntingYard(tokenize('-2+5'));
    assert.deepStrictEqual(rpn, [2, 'NEG', 5, '+']);
});

test('Shunting yard parses negative factor', () => {
    const rpn = shuntingYard(tokenize('1*-2'));
    assert.deepStrictEqual(rpn, [1, 2, 'NEG', '*']);
});

test('Evaluation handles nested expression with range', () => {
    const result = evaluateExpression('((1-2)~3)');
    assert.strictEqual(result.min, -1);
    assert.strictEqual(result.max, 3);
    assert.strictEqual(result.mean, 1);
});

test('Evaluation computes simple addition with leading negative', () => {
    const result = evaluateExpression('-2+5');
    assert.strictEqual(result.mean, 3);
});

test('Evaluation resolves precedence with power', () => {
    const result = evaluateExpression('-2^2');
    // Our parser binds unary minus tighter than exponent, so (-2)^2
    assert.strictEqual(result.mean, 4);
});

test('Currency expression evaluates into PLN with simplification steps', () => {
    const evaluation = evaluateExpressionWithSteps(
        '120eur + 50pln to pln * 2'
    );

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'pln');
    assert.ok(Array.isArray(evaluation.steps));
    assert.ok(evaluation.steps.length >= 4);
    assert.match(evaluation.steps[0], /to pln \* 2/i);
    assert.match(evaluation.steps[evaluation.steps.length - 1], /pln$/i);
    assert.strictEqual(evaluation.result.samples, null);
    assert.strictEqual(Number.isFinite(evaluation.result.mean), true);
});

test('evaluateExpressionWithSteps falls back to core evaluator for non-currency expressions', () => {
    const evaluation = evaluateExpressionWithSteps('2+3*4');
    assert.strictEqual(evaluation.isCurrencyExpression, false);
    assert.strictEqual(evaluation.result.mean, 14);
    assert.deepStrictEqual(evaluation.steps, []);
});

test('Currency conversion can bridge through intermediary rates', () => {
    const evaluation = evaluateExpressionWithSteps(
        '1usd + 1pln to eur',
        undefined,
        {
            currencyRates: {
                eur: { usd: 2, pln: 4 },
            },
        }
    );

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'eur');
    assert.strictEqual(evaluation.result.display, '0.75eur');
});

test('Currency suffix can follow grouped range expressions', () => {
    const evaluation = evaluateExpressionWithSteps('(60~115)pln to eur', 128);

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'eur');
    assert.strictEqual(evaluation.result.display, '20.73eur');
    assert.ok(Array.isArray(evaluation.result.samples));
    assert.strictEqual(evaluation.result.samples.length, 128);
    assert.ok(evaluation.result.min <= evaluation.result.max);
});

test('Currency range expression keeps samples through conversion and tail arithmetic', () => {
    const evaluation = evaluateExpressionWithSteps('(60~115)pln to eur * 12', 256);

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'eur');
    assert.strictEqual(evaluation.result.display, '248.76eur');
    assert.ok(Array.isArray(evaluation.result.samples));
    assert.strictEqual(evaluation.result.samples.length, 256);
    assert.ok(evaluation.result.min <= evaluation.result.mean);
    assert.ok(evaluation.result.mean <= evaluation.result.max);
});

test('Currency range expression can combine uncertain and fixed currency amounts', () => {
    const evaluation = evaluateExpressionWithSteps('(60~115)pln + 10pln to eur', 256);

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'eur');
    assert.strictEqual(evaluation.result.display, '23.10eur');
    assert.ok(Array.isArray(evaluation.result.samples));
    assert.strictEqual(evaluation.result.samples.length, 256);
});

test('Currency expressions without range stay exact and do not produce samples', () => {
    const evaluation = evaluateExpressionWithSteps('2pln + 3pln to eur * 4', 256);

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'eur');
    assert.strictEqual(evaluation.result.samples, null);
});

test('Currency range conversion throws when exchange path is missing', () => {
    assert.throws(
        () => evaluateExpressionWithSteps('(1~2)pln to xyz', 128),
        /Missing exchange rate path/i
    );
});

test('Currency range samples produce quantiles bounded by sampled min and max', () => {
    const evaluation = evaluateExpressionWithSteps('(1~2)pln to eur', 512);
    const samples = evaluation.result.samples;
    const quantiles = getQuantiles(samples);
    const sampleMin = Math.min(...samples);
    const sampleMax = Math.max(...samples);

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'eur');
    assert.ok(Array.isArray(samples));
    assert.strictEqual(samples.length, 512);
    assert.ok(Number.isFinite(quantiles.p05));
    assert.ok(Number.isFinite(quantiles.p95));
    assert.ok(sampleMin <= quantiles.p05);
    assert.ok(quantiles.p05 <= quantiles.p95);
    assert.ok(quantiles.p95 <= sampleMax);
});

test('Grouped currency suffix without conversion is treated as currency expression', () => {
    const evaluation = evaluateExpressionWithSteps('(1~5)pln', 128);

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'pln');
    assert.strictEqual(evaluation.result.display, '3.00pln');
    assert.ok(Array.isArray(evaluation.result.samples));
    assert.strictEqual(evaluation.result.samples.length, 128);
});

test('Unary and currency subtraction with grouped currency suffix are supported', () => {
    const unaryEvaluation = evaluateExpressionWithSteps('-(1~5)pln', 128);
    const subtractionEvaluation = evaluateExpressionWithSteps('0pln-(1~5)pln', 128);

    assert.strictEqual(unaryEvaluation.isCurrencyExpression, true);
    assert.strictEqual(unaryEvaluation.currency, 'pln');
    assert.strictEqual(unaryEvaluation.result.display, '-3.00pln');
    assert.ok(Array.isArray(unaryEvaluation.result.samples));
    assert.strictEqual(unaryEvaluation.result.samples.length, 128);

    assert.strictEqual(subtractionEvaluation.isCurrencyExpression, true);
    assert.strictEqual(subtractionEvaluation.currency, 'pln');
    assert.strictEqual(subtractionEvaluation.result.display, '-3.00pln');
    assert.ok(Array.isArray(subtractionEvaluation.result.samples));
    assert.strictEqual(subtractionEvaluation.result.samples.length, 128);
});

test('Currency suffix on the right range operand applies to the whole range (1~10eur == (1~10)eur)', () => {
    const evaluation = evaluateExpressionWithSteps('1~10eur to pln', 128);
    const grouped = evaluateExpressionWithSteps('(1~10)eur to pln', 128);

    assert.strictEqual(evaluation.isCurrencyExpression, true);
    assert.strictEqual(evaluation.currency, 'pln');
    assert.strictEqual(evaluation.result.display, grouped.result.display);
    assert.strictEqual(evaluation.result.display, '23.21pln');
    assert.deepStrictEqual(evaluation.steps, grouped.steps);
    assert.strictEqual(evaluation.result.samples.length, 128);
});

test('Range with currency suffix works inside a longer product chain', () => {
    const evaluation = evaluateExpressionWithSteps('7 ~ 10 * 17~23 * 1~10eur to pln', 128);

    assert.strictEqual(evaluation.currency, 'pln');
    assert.strictEqual(evaluation.result.display, '3945.70pln');
    assert.strictEqual(evaluation.steps[0], '7 ~ 10 * 17 ~ 23 * 1 ~ 10 * 1eur to pln');
});

test('Range between two amounts in the same currency is a range in that currency', () => {
    const evaluation = evaluateExpressionWithSteps('10eur~20eur to pln', 128);

    assert.strictEqual(evaluation.currency, 'pln');
    assert.strictEqual(evaluation.result.display, '63.30pln');
});

test('Range between amounts in different currencies is rejected', () => {
    assert.throws(
        () => evaluateExpressionWithSteps('10eur~20usd to pln', 128),
        /same currency/i,
    );
});

test('Text histogram keeps its line format (label | bar, mean annotation on the mean bin)', () => {
    const lines = generateTextHistogram([1, 2, 3, 4], { bins: 2, width: 4 });
    assert.deepStrictEqual(lines, [' 2.5000 | ████ (mean≈2.5000)', ' 1.0000 | ████']);
});

test('computeHistogramBins returns ascending bins with counts, max count and mean bin', () => {
    const histogram = computeHistogramBins([1, 2, 3, 4], { bins: 2 });
    assert.deepStrictEqual(
        histogram.bins.map(({ start, end, count }) => ({ start, end, count })),
        [{ start: 1, end: 2.5, count: 2 }, { start: 2.5, end: 4, count: 2 }],
    );
    assert.strictEqual(histogram.maxCount, 2);
    assert.strictEqual(histogram.sampleMean, 2.5);
    assert.strictEqual(histogram.meanBinIndex, 1);
    assert.strictEqual(histogram.sampleCount, 4);
});

test('computeHistogramBins can trim outliers by quantile', () => {
    const samples = [-1000, 1000];
    for (let i = 1; i <= 100; i++) samples.push(i);
    const histogram = computeHistogramBins(samples, { bins: 4, trim: 0.02 });
    assert.strictEqual(histogram.minVal, 2);
    assert.strictEqual(histogram.maxVal, 99);
    assert.strictEqual(histogram.sampleCount, 98);
    assert.strictEqual(histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 98);
    assert.strictEqual(histogram.validCount, 102);
    assert.strictEqual(histogram.belowCount, 2);
});

test('computeHistogramBins returns null without usable samples', () => {
    assert.strictEqual(computeHistogramBins([]), null);
    assert.strictEqual(computeHistogramBins([NaN, Infinity]), null);
    assert.strictEqual(computeHistogramBins(null), null);
});

const changedTexts = (prev, next) => {
    const nextTokens = tokenizeStep(next);
    const flags = diffStepTokens(tokenizeStep(prev), nextTokens);
    return nextTokens.filter((_, i) => flags[i]).map((t) => t.text);
};

test('tokenizeStep splits numbers, units, operators, parens and the to keyword', () => {
    assert.deepStrictEqual(
        tokenizeStep('2 * (3eur + 4eur) ^ 2').map((t) => `${t.type}:${t.text}`),
        ['number:2', 'operator:*', 'paren:(', 'number:3eur', 'operator:+', 'number:4eur', 'paren:)', 'operator:^', 'number:2'],
    );
    const [money, keyword, unit] = tokenizeStep('16.5eur to pln');
    assert.deepStrictEqual(money, { type: 'number', text: '16.5eur', value: '16.5', unit: 'eur' });
    assert.strictEqual(keyword.type, 'keyword');
    assert.deepStrictEqual(unit, { type: 'unit', text: 'pln' });
});

test('tokenizeStep keeps exponent form and unary minus apart', () => {
    assert.deepStrictEqual(tokenizeStep('1.0000e+9eur').map((t) => [t.value, t.unit]), [['1.0000e+9', 'eur']]);
    assert.deepStrictEqual(tokenizeStep('--3eur').map((t) => t.text), ['-', '-', '3eur']);
});

test('diffStepTokens flags only the values a step computed', () => {
    assert.deepStrictEqual(changedTexts('90 * 72eur + 7 * 8.45 * 38eur', '6480eur + 59.15 * 38eur'), ['6480eur', '59.15']);
    assert.deepStrictEqual(changedTexts('6480eur + 59.15 * 38eur', '6480eur + 2247.7eur'), ['2247.7eur']);
    assert.deepStrictEqual(changedTexts('6480eur + 2247.7eur', '8727.7eur'), ['8727.7eur']);
    assert.deepStrictEqual(changedTexts('2 * (3eur + 4eur) ^ 2', '2 * 7eur ^ 2'), ['7eur']);
    assert.deepStrictEqual(changedTexts('16.5eur to pln * 2', '69.63pln * 2'), ['69.63pln']);
    assert.deepStrictEqual(changedTexts('120usd + 50eur to pln', '175usd to pln'), ['175usd']);
});

test('Sampling is seeded: the same expression gives the same samples on every run', () => {
    const first = evaluateExpression('1~10 * 2~3', 257).samples;
    evaluateExpression('5~6', 3); // odd sample count leaves a Box-Muller spare behind
    assert.deepStrictEqual(evaluateExpression('1~10 * 2~3', 257).samples, first);

    const currencySamples = () => evaluateExpressionWithSteps('(1~10)eur * 3 to pln', 101).result.samples;
    assert.deepStrictEqual(currencySamples(), currencySamples());
});

test('Seeding keeps ranges inside one expression independent', () => {
    const samples = evaluateExpression('(1~10) - (1~10)', 500).samples;
    assert.ok(Math.max(...samples) - Math.min(...samples) > 1);
});

test('percentileOfSorted uses nearest rank and clamps the ends', () => {
    const sorted = sortedValidSamples(Array.from({ length: 100 }, (_, i) => 100 - i));
    assert.deepStrictEqual([5, 95, 0, 100, 50, 2.5].map((p) => percentileOfSorted(sorted, p)), [5, 95, 1, 100, 50, 3]);
    assert.deepStrictEqual(sortedValidSamples([NaN, 3, Infinity, 1]), [1, 3]);
    assert.ok(Number.isNaN(percentileOfSorted([], 5)));
});

test('percentRankOfSorted inverts percentileOfSorted', () => {
    const sorted = sortedValidSamples(Array.from({ length: 100 }, (_, i) => i + 1));
    assert.strictEqual(percentRankOfSorted(sorted, 50), 50);
    assert.strictEqual(percentRankOfSorted(sorted, 0), 0);
    assert.strictEqual(percentRankOfSorted(sorted, 1000), 100);
    assert.strictEqual(percentileOfSorted(sorted, percentRankOfSorted(sorted, 37)), 37);
    assert.ok(Number.isNaN(percentRankOfSorted([], 1)));
});

test('niceTicks picks round steps inside the span', () => {
    assert.deepStrictEqual(niceTicks(4850.6, 5064.8, 5).ticks, [4900, 4950, 5000, 5050]);
    assert.deepStrictEqual(niceTicks(-37, -3, 4).ticks, [-30, -20, -10]);
    assert.deepStrictEqual(niceTicks(-22.12, 295.22, 5).ticks, [0, 50, 100, 150, 200, 250]);
    assert.deepStrictEqual(niceTicks(0.000113, 0.000191, 4).ticks, [0.00012, 0.00014, 0.00016, 0.00018]);
    assert.deepStrictEqual(niceTicks(5, 5).ticks, []);
});

test('niceTicks stays bounded at huge magnitudes', () => {
    const { ticks } = niceTicks(1e20, 1e20 + 1e5, 5);
    assert.ok(ticks.length <= 20);
});
