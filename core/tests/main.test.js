const test = require('node:test');
const assert = require('assert');
const { tokenize, shuntingYard, evaluateExpression, evaluateExpressionWithSteps } = require('../calc-core');

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
