const test = require('node:test');
const assert = require('assert');
const { tokenize, shuntingYard, evaluateExpression, evaluateExpressionWithSteps, getQuantiles } = require('../calc-core');

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
