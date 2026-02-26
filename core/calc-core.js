// Shared probabilistic calculator core logic (browser, Raycast, and tests)
// Exposes tokenize, shuntingYard, evalRpn, evaluateExpression, getQuantiles, formatNumber, generateTextHistogram

const DEFAULT_SAMPLES = 10000;
const DEFAULT_BINS = 20;
const DEFAULT_WIDTH = 40;
const DEFAULT_BAR = "█";
const BASE_CURRENCY_TOKEN = "__base__";
const DEFAULT_CURRENCY_RATES = {
  eur: { pln: 4.22 },
  pln: { eur: 1 / 4.22 },
};

let spareRandom = null;

// Gaussian (normal) RNG using the Box-Muller transform; returns N(mean, stdDev)
function gaussianRandom(mean, stdDev) {
  let u, v, s;
  if (spareRandom !== null) {
    const temp = spareRandom;
    spareRandom = null;
    return mean + stdDev * temp;
  }
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const mul = Math.sqrt((-2.0 * Math.log(s)) / s);
  spareRandom = v * mul;
  return mean + stdDev * (u * mul);
}

// Generate draws from N(mean, stdDev); fast path for zero-width ranges
function generateSamples(mean, stdDev, sampleCount) {
  if (!sampleCount || sampleCount <= 0) return [];
  if (stdDev === 0) {
    return Array(sampleCount).fill(mean);
  }
  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(gaussianRandom(mean, stdDev));
  }
  return samples;
}

// --- Tokenizer ---
// Tokenize an expression string into numbers/operators; minus stays separate for unary detection
function tokenize(s) {
  const tokens = [];
  const NUMBER_REGEX = /^[0-9]+(\.[0-9]+)?/;
  const OPERATOR_REGEX = /^[+\-*^/~()]/;
  const WHITESPACE_REGEX = /^\s+/;
  let remaining = s.trim();
  const originalString = s;
  while (remaining.length > 0) {
    let match;
    match = remaining.match(WHITESPACE_REGEX);
    if (match) {
      remaining = remaining.substring(match[0].length);
      continue;
    }
    match = remaining.match(NUMBER_REGEX);
    if (match) {
      tokens.push(parseFloat(match[0]));
      remaining = remaining.substring(match[0].length);
      continue;
    }
    match = remaining.match(OPERATOR_REGEX);
    if (match) {
      tokens.push(match[0]);
      remaining = remaining.substring(match[0].length);
      continue;
    }
    throw new Error(
      `Syntax Error: Cannot parse near '${remaining.substring(0, 10)}...' in expression '${originalString}'`,
    );
  }
  return tokens;
}

// Convert tokens to Reverse Polish Notation (handles unary minus via synthetic NEG token)
function shuntingYard(tokens) {
  let prevToken = null;
  const outputQueue = [];
  const operatorStack = [];
  const precedence = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3, "~": 4, NEG: 5 };
  const associativity = {
    "+": "L",
    "-": "L",
    "*": "L",
    "/": "L",
    "^": "L",
    "~": "R",
    NEG: "R",
  };
  for (const token of tokens) {
    if (token === '-') {
      if (
        prevToken == null ||
        prevToken === '(' ||
        (typeof prevToken !== 'number' && prevToken !== ')')
      ) {
        operatorStack.push('NEG');
        prevToken = token;
        continue;
      }
    }
    if (typeof token === "number") {
      outputQueue.push(token);
      prevToken = token;
    } else if (token === "(") {
      operatorStack.push(token);
      prevToken = token;
    } else if (token === ")") {
      while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1] !== "(") {
        outputQueue.push(operatorStack.pop());
      }
      if (operatorStack.length === 0)
        throw new Error("Mismatched parentheses: Found ')' without matching '('");
      operatorStack.pop();
    } else if (precedence[token]) {
      const op1 = token;
      while (
        operatorStack.length > 0 &&
        operatorStack[operatorStack.length - 1] !== "(" &&
        (precedence[operatorStack[operatorStack.length - 1]] > precedence[op1] ||
          (precedence[operatorStack[operatorStack.length - 1]] === precedence[op1] && associativity[op1] === "L"))
      ) {
        outputQueue.push(operatorStack.pop());
      }
      operatorStack.push(op1);
      prevToken = token;
    } else {
      throw new Error(`Unknown token: ${token}`);
    }
  }
  while (operatorStack.length > 0) {
    const op = operatorStack.pop();
    if (op === "(") throw new Error("Mismatched parentheses: Found '(' without matching ')'");
    outputQueue.push(op);
  }
  return outputQueue;
}

// Helper for operating on sample arrays
function operateSamples(samplesA, samplesB, operation, sampleCount) {
  const aIsArray = Array.isArray(samplesA);
  const bIsArray = Array.isArray(samplesB);
  if (!aIsArray && !bIsArray) return null; // keep exact arithmetic if both operands are exact numbers

  const N = sampleCount;
  const resultSamples = Array(N);

  for (let i = 0; i < N; i++) {
    const a = aIsArray ? samplesA[i] : samplesA;
    const b = bIsArray ? samplesB[i] : samplesB;

    switch (operation) {
      case "+":
        resultSamples[i] = a + b;
        break;
      case "-":
        resultSamples[i] = a - b;
        break;
      case "*":
        resultSamples[i] = a * b;
        break;
      case "/":
        resultSamples[i] = b === 0 ? NaN : a / b;
        break;
      case "^":
        resultSamples[i] = Math.pow(a, b);
        break;
      default:
        throw new Error(`Unknown sample operation: ${operation}`);
    }
  }
  return resultSamples;
}

// Evaluate RPN queue into an UncertainValue (mean/min/max/samples), handling NEG and '~'
function evalRpn(rpnQueue, sampleCount = DEFAULT_SAMPLES) {
  const stack = [];

  const createNumberValue = (num) => ({
    mean: num,
    min: num,
    max: num,
    samples: null,
  });

  for (const token of rpnQueue) {
    if (token === 'NEG') {
      if (stack.length < 1) throw new Error("Not enough operands for unary minus");
      const a = stack.pop();
      const nmin = Math.min(-a.max, -a.min);
      const nmax = Math.max(-a.max, -a.min);
      stack.push({
        mean: -a.mean,
        min: nmin,
        max: nmax,
        samples: a.samples ? a.samples.map(x => -x) : null,
      });
      continue;
    }

    if (typeof token === "number") {
      stack.push(createNumberValue(token));
    } else if (token === "~") {
      if (stack.length < 2) throw new Error("Not enough operands for '~'");
      const uvB = stack.pop();
      const uvA = stack.pop();

      if (
        uvA.samples !== null ||
        uvB.samples !== null ||
        typeof uvA.mean !== "number" ||
        typeof uvB.mean !== "number"
      ) {
        throw new Error("Operands for '~' must be exact numbers (e.g., 100~200, not (5~10)~200)");
      }
      const a = uvA.mean;
      const b = uvB.mean;

      const mean = (a + b) / 2.0;
      const stdDev = Math.abs(b - a) / 3.28970725;
      const samples = generateSamples(mean, stdDev, sampleCount);

      stack.push({
        mean: mean,
        min: Math.min(a, b),
        max: Math.max(a, b),
        samples: samples,
      });
    } else if ("+-*/^".includes(token)) {
      if (stack.length < 2) throw new Error(`Not enough operands for '${token}'`);
      const uvB = stack.pop();
      const uvA = stack.pop();

      let newMean, newMin, newMax;

      switch (token) {
        case "+":
          newMean = uvA.mean + uvB.mean;
          break;
        case "-":
          newMean = uvA.mean - uvB.mean;
          break;
        case "*":
          newMean = uvA.mean * uvB.mean;
          break;
        case "/":
          newMean = uvB.mean === 0 ? NaN : uvA.mean / uvB.mean;
          break;
        case "^":
          newMean = Math.pow(uvA.mean, uvB.mean);
          break;
      }

      const aMin = uvA.min, aMax = uvA.max;
      const bMin = uvB.min, bMax = uvB.max;

      switch (token) {
        case "+":
          newMin = aMin + bMin;
          newMax = aMax + bMax;
          break;
        case "-":
          newMin = aMin - bMax;
          newMax = aMax - bMin;
          break;
        case "*":
          const prods = [aMin * bMin, aMin * bMax, aMax * bMin, aMax * bMax];
          newMin = Math.min(...prods);
          newMax = Math.max(...prods);
          break;
        case "^":
          const powers = [aMin ** bMin, aMin ** bMax, aMax ** bMin, aMax ** bMax];
          newMin = Math.min(...powers);
          newMax = Math.max(...powers);
          break;
        case "/":
          if (bMin <= 0 && bMax >= 0) {
            if (bMin === 0 && bMax === 0) {
              newMin = NaN;
              newMax = NaN;
              newMean = NaN;
            } else {
              if (aMin === 0 && aMax === 0) {
                newMin = 0;
                newMax = 0;
              } else {
                newMin = -Infinity;
                newMax = Infinity;
              }
            }
          } else {
            const quots = [aMin / bMin, aMin / bMax, aMax / bMin, aMax / bMax];
            newMin = Math.min(...quots);
            newMax = Math.max(...quots);
          }
          break;
      }

      const samplesA = uvA.samples ?? uvA.mean;
      const samplesB = uvB.samples ?? uvB.mean;
      const newSamples = operateSamples(samplesA, samplesB, token, sampleCount);

      stack.push({
        mean: newMean,
        min: newMin,
        max: newMax,
        samples: newSamples,
      });
    } else {
      throw new Error(`Internal Error: Unknown RPN token: ${token}`);
    }
  }

  if (stack.length === 0) return null;
  if (stack.length > 1) throw new Error("Invalid expression: Operands left over");
  return stack[0];
}

// Convenience: run full pipeline (tokenize -> RPN -> evaluate) and return UncertainValue
function evaluateExpression(expression, sampleCount = DEFAULT_SAMPLES) {
  const tokens = tokenize(expression);
  const rpn = shuntingYard(tokens);
  return evalRpn(rpn, sampleCount);
}

function roundCurrencyValue(value) {
  if (isNaN(value) || !isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatCurrencyAmount(value, fixedDecimals = false) {
  if (isNaN(value) || !isFinite(value)) return formatNumber(value);
  const rounded = roundCurrencyValue(value);
  if (fixedDecimals) return rounded.toFixed(2);
  return rounded.toFixed(2).replace(/\.?0+$/, "");
}

function formatScalarAmount(value) {
  if (isNaN(value) || !isFinite(value)) return formatNumber(value);
  const normalized = Math.abs(value) < 1e-12 ? 0 : value;
  const fixed = normalized.toFixed(6);
  return fixed.replace(/\.?0+$/, "");
}

function createScalarLiteral(value) {
  return { type: "literal", kind: "scalar", value };
}

function createMoneyLiteral(value, currency) {
  return { type: "literal", kind: "money", value, currency: currency.toLowerCase() };
}

function isLiteralNode(node) {
  return !!node && node.type === "literal";
}

function cloneCurrencyNode(node) {
  if (isLiteralNode(node)) {
    if (node.kind === "money") return createMoneyLiteral(node.value, node.currency);
    return createScalarLiteral(node.value);
  }
  if (node.type === "base") return { type: "base" };
  if (node.type === "unary") {
    return { type: "unary", operator: node.operator, value: cloneCurrencyNode(node.value) };
  }
  if (node.type === "binary") {
    return {
      type: "binary",
      operator: node.operator,
      left: cloneCurrencyNode(node.left),
      right: cloneCurrencyNode(node.right),
    };
  }
  throw new Error(`Unknown node type: ${node.type}`);
}

function lexCurrencyExpression(input) {
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < input.length && /[0-9]/.test(input[i])) i++;
      if (i < input.length && input[i] === ".") {
        i++;
        while (i < input.length && /[0-9]/.test(input[i])) i++;
      }
      const numberRaw = input.slice(start, i);
      const numberValue = parseFloat(numberRaw);

      const suffixStart = i;
      while (i < input.length && /[A-Za-z]/.test(input[i])) i++;
      const suffix = input.slice(suffixStart, i);

      if (suffix) {
        tokens.push({
          type: "money",
          value: numberValue,
          currency: suffix.toLowerCase(),
          raw: input.slice(start, i),
        });
      } else {
        tokens.push({ type: "number", value: numberValue, raw: numberRaw });
      }
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z_]/.test(input[i])) i++;
      const raw = input.slice(start, i);
      const lowered = raw.toLowerCase();
      if (lowered === "to") {
        tokens.push({ type: "to", raw });
      } else {
        tokens.push({ type: "identifier", value: lowered, raw });
      }
      continue;
    }

    if ("+-*/^()~".includes(ch)) {
      tokens.push({ type: "operator", value: ch, raw: ch });
      i++;
      continue;
    }

    throw new Error(`Syntax Error: Unsupported character '${ch}' in expression`);
  }

  return tokens;
}

function formatTokenSequence(tokens) {
  const raw = tokens
    .map((token) => {
      if (token.type === "money") return `${formatCurrencyAmount(token.value)}${token.currency}`;
      if (token.type === "number") return formatScalarAmount(token.value);
      if (token.type === "identifier") return token.value;
      if (token.type === "operator") return token.value;
      if (token.type === "to") return "to";
      return token.raw ?? "";
    })
    .join(" ");

  return raw
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+([+\-*/^~])/g, " $1")
    .replace(/([+\-*/^~])\s+/g, "$1 ")
    .trim();
}

function findTopLevelToToken(tokens) {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "operator" && token.value === "(") depth++;
    else if (token.type === "operator" && token.value === ")") depth--;
    else if (token.type === "to" && depth === 0) return i;
  }
  return -1;
}

function parseCurrencyExpressionTokens(tokens, options = {}) {
  const allowBaseToken = !!options.allowBaseToken;
  const allowCurrencySuffix = options.allowCurrencySuffix !== false;
  let index = 0;

  const peek = (offset = 0) => tokens[index + offset] || null;
  const consume = () => {
    const token = tokens[index];
    index++;
    return token;
  };

  const matchOperator = (value) => {
    const token = peek();
    if (token && token.type === "operator" && token.value === value) {
      consume();
      return true;
    }
    return false;
  };

  const parseExpressionNode = () => parseAddSub();

  const parseAddSub = () => {
    let node = parseMulDiv();
    while (true) {
      if (matchOperator("+")) node = { type: "binary", operator: "+", left: node, right: parseMulDiv() };
      else if (matchOperator("-")) node = { type: "binary", operator: "-", left: node, right: parseMulDiv() };
      else break;
    }
    return node;
  };

  const parseMulDiv = () => {
    let node = parsePower();
    while (true) {
      if (matchOperator("*")) node = { type: "binary", operator: "*", left: node, right: parsePower() };
      else if (matchOperator("/")) node = { type: "binary", operator: "/", left: node, right: parsePower() };
      else break;
    }
    return node;
  };

  const parsePower = () => {
    let node = parseRange();
    while (matchOperator("^")) {
      node = { type: "binary", operator: "^", left: node, right: parseRange() };
    }
    return node;
  };

  const parseRange = () => {
    let node = parseUnary();
    while (matchOperator("~")) {
      node = { type: "binary", operator: "~", left: node, right: parseUnary() };
    }
    return node;
  };

  const parseUnary = () => {
    if (matchOperator("-")) return { type: "unary", operator: "-", value: parseUnary() };
    return parsePrimary();
  };

  const parsePrimary = () => {
    const token = peek();
    if (!token) throw new Error("Unexpected end of expression");

    if (token.type === "operator" && token.value === "(") {
      consume();
      const node = parseExpressionNode();
      if (!matchOperator(")")) throw new Error("Mismatched parentheses in expression");
      const next = peek();
      if (
        allowCurrencySuffix &&
        next &&
        next.type === "identifier" &&
        next.value !== BASE_CURRENCY_TOKEN
      ) {
        consume();
        // Support grouped scalar expressions followed by a currency suffix, e.g. (60~115)pln.
        // This is equivalent to multiplying the grouped value by a 1-unit currency literal.
        return {
          type: "binary",
          operator: "*",
          left: node,
          right: createMoneyLiteral(1, next.value),
        };
      }
      return node;
    }

    if (token.type === "money") {
      consume();
      return createMoneyLiteral(token.value, token.currency);
    }

    if (token.type === "number") {
      consume();
      const next = peek();
      if (
        allowCurrencySuffix &&
        next &&
        next.type === "identifier" &&
        next.value !== BASE_CURRENCY_TOKEN
      ) {
        consume();
        return createMoneyLiteral(token.value, next.value);
      }
      return createScalarLiteral(token.value);
    }

    if (token.type === "identifier") {
      consume();
      if (allowBaseToken && token.value === BASE_CURRENCY_TOKEN) {
        return { type: "base" };
      }
      throw new Error(`Unexpected identifier '${token.value}'`);
    }

    throw new Error(`Unexpected token '${token.raw ?? token.type}'`);
  };

  const parsed = parseExpressionNode();
  if (index !== tokens.length) {
    const token = tokens[index];
    throw new Error(`Unexpected token '${token.raw ?? token.type}'`);
  }
  return parsed;
}

function buildCurrencyRateMap(customRates = null) {
  const map = {};

  const addRate = (from, to, rate) => {
    if (!from || !to || typeof rate !== "number" || !isFinite(rate) || rate <= 0) return;
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();
    if (!map[fromKey]) map[fromKey] = {};
    map[fromKey][toKey] = rate;
  };

  const addRateSet = (rateSet) => {
    if (!rateSet || typeof rateSet !== "object") return;
    for (const [from, targets] of Object.entries(rateSet)) {
      if (!targets || typeof targets !== "object") continue;
      for (const [to, rate] of Object.entries(targets)) {
        addRate(from, to, rate);
      }
    }
  };

  addRateSet(DEFAULT_CURRENCY_RATES);
  addRateSet(customRates);

  for (const [from, targets] of Object.entries(map)) {
    for (const [to, rate] of Object.entries(targets)) {
      if (!map[to]) map[to] = {};
      map[to][from] = 1 / rate;
    }
  }

  return map;
}

function getCurrencyRate(fromCurrency, toCurrency, rates) {
  const from = fromCurrency.toLowerCase();
  const to = toCurrency.toLowerCase();
  if (from === to) return 1;
  if (rates[from] && typeof rates[from][to] === "number") return rates[from][to];
  if (rates[to] && typeof rates[to][from] === "number") return 1 / rates[to][from];

  // Fall back to graph traversal so currencies can be bridged through
  // intermediary rates (for example PLN->EUR->USD).
  const visited = new Set([from]);
  const queue = [{ currency: from, cumulativeRate: 1 }];

  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = rates[current.currency] || {};

    for (const [nextCurrency, edgeRate] of Object.entries(neighbors)) {
      if (typeof edgeRate !== "number" || !isFinite(edgeRate) || edgeRate <= 0) continue;
      if (visited.has(nextCurrency)) continue;

      const nextRate = current.cumulativeRate * edgeRate;
      if (nextCurrency === to) return nextRate;

      visited.add(nextCurrency);
      queue.push({ currency: nextCurrency, cumulativeRate: nextRate });
    }
  }

  throw new Error(`Missing exchange rate path for ${fromCurrency}->${toCurrency}`);
}

function convertLiteralCurrency(literal, targetCurrency, rates) {
  if (!isLiteralNode(literal)) throw new Error("Cannot convert non-literal value");
  if (literal.kind !== "money") throw new Error(`Cannot convert scalar value to ${targetCurrency}`);
  const target = targetCurrency.toLowerCase();
  if (literal.currency === target) return createMoneyLiteral(literal.value, target);
  const rate = getCurrencyRate(literal.currency, target, rates);
  return createMoneyLiteral(roundCurrencyValue(literal.value * rate), target);
}

function evaluateCurrencyUnary(node) {
  if (node.operator !== "-") throw new Error(`Unsupported unary operator '${node.operator}'`);
  if (!isLiteralNode(node.value)) throw new Error("Unary operator requires literal operand");
  if (node.value.kind === "money") {
    return createMoneyLiteral(roundCurrencyValue(-node.value.value), node.value.currency);
  }
  return createScalarLiteral(-node.value.value);
}

function evaluateCurrencyBinary(node, rates) {
  if (!isLiteralNode(node.left) || !isLiteralNode(node.right)) {
    throw new Error(`Operator '${node.operator}' requires literal operands`);
  }

  const left = node.left;
  const right = node.right;
  const op = node.operator;

  if (op === "~") {
    if (left.kind !== "scalar" || right.kind !== "scalar") {
      throw new Error("Range operator '~' supports scalar values only");
    }
    return createScalarLiteral((left.value + right.value) / 2);
  }

  if (op === "+" || op === "-") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      return createScalarLiteral(op === "+" ? left.value + right.value : left.value - right.value);
    }
    if (left.kind === "money" && right.kind === "money") {
      const rightInLeftCurrency =
        right.currency === left.currency ? right : convertLiteralCurrency(right, left.currency, rates);
      const resultValue = op === "+" ? left.value + rightInLeftCurrency.value : left.value - rightInLeftCurrency.value;
      return createMoneyLiteral(roundCurrencyValue(resultValue), left.currency);
    }
    throw new Error(`Cannot ${op === "+" ? "add" : "subtract"} scalar and currency values`);
  }

  if (op === "*") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      return createScalarLiteral(left.value * right.value);
    }
    if (left.kind === "money" && right.kind === "scalar") {
      return createMoneyLiteral(roundCurrencyValue(left.value * right.value), left.currency);
    }
    if (left.kind === "scalar" && right.kind === "money") {
      return createMoneyLiteral(roundCurrencyValue(left.value * right.value), right.currency);
    }
    throw new Error("Multiplying two currency values is not supported");
  }

  if (op === "/") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      return createScalarLiteral(right.value === 0 ? NaN : left.value / right.value);
    }
    if (left.kind === "money" && right.kind === "scalar") {
      return createMoneyLiteral(roundCurrencyValue(right.value === 0 ? NaN : left.value / right.value), left.currency);
    }
    if (left.kind === "money" && right.kind === "money") {
      return createScalarLiteral(right.value === 0 ? NaN : left.value / right.value);
    }
    throw new Error("Cannot divide scalar by a currency value");
  }

  if (op === "^") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      return createScalarLiteral(Math.pow(left.value, right.value));
    }
    if (left.kind === "money" && right.kind === "scalar") {
      return createMoneyLiteral(roundCurrencyValue(Math.pow(left.value, right.value)), left.currency);
    }
    throw new Error("Power is supported for scalar^scalar or money^scalar only");
  }

  throw new Error(`Unsupported operator '${op}'`);
}

function createCurrencyValue(kind, mean, min, max, samples = null, currency = null) {
  if (kind === "money") {
    return { kind, currency, mean, min, max, samples };
  }
  return { kind, mean, min, max, samples };
}

function cloneCurrencyValue(value) {
  return createCurrencyValue(
    value.kind,
    value.mean,
    value.min,
    value.max,
    Array.isArray(value.samples) ? [...value.samples] : null,
    value.kind === "money" ? value.currency : null,
  );
}

function createCurrencyValueFromLiteral(literal) {
  if (literal.kind === "money") {
    return createCurrencyValue("money", literal.value, literal.value, literal.value, null, literal.currency);
  }
  return createCurrencyValue("scalar", literal.value, literal.value, literal.value);
}

function convertCurrencyValue(value, targetCurrency, rates) {
  if (value.kind !== "money") throw new Error(`Cannot convert scalar value to ${targetCurrency}`);
  const target = targetCurrency.toLowerCase();
  if (value.currency === target) return cloneCurrencyValue(value);

  const rate = getCurrencyRate(value.currency, target, rates);
  const convertAmount = (amount) => roundCurrencyValue(amount * rate);
  const convertedMin = convertAmount(value.min);
  const convertedMax = convertAmount(value.max);

  return createCurrencyValue(
    "money",
    convertAmount(value.mean),
    Math.min(convertedMin, convertedMax),
    Math.max(convertedMin, convertedMax),
    Array.isArray(value.samples) ? value.samples.map(convertAmount) : null,
    target,
  );
}

function getMulBounds(aMin, aMax, bMin, bMax) {
  const products = [aMin * bMin, aMin * bMax, aMax * bMin, aMax * bMax];
  return { min: Math.min(...products), max: Math.max(...products) };
}

function getPowBounds(aMin, aMax, bMin, bMax) {
  const powers = [aMin ** bMin, aMin ** bMax, aMax ** bMin, aMax ** bMax];
  return { min: Math.min(...powers), max: Math.max(...powers) };
}

function getDivBounds(aMin, aMax, bMin, bMax) {
  if (bMin <= 0 && bMax >= 0) {
    if (bMin === 0 && bMax === 0) return { min: NaN, max: NaN };
    if (aMin === 0 && aMax === 0) return { min: 0, max: 0 };
    return { min: -Infinity, max: Infinity };
  }
  const quotients = [aMin / bMin, aMin / bMax, aMax / bMin, aMax / bMax];
  return { min: Math.min(...quotients), max: Math.max(...quotients) };
}

function evaluateCurrencyBinaryWithUncertainty(operator, left, right, rates, sampleCount) {
  if (operator === "~") {
    if (left.kind !== "scalar" || right.kind !== "scalar") {
      throw new Error("Range operator '~' supports scalar values only");
    }
    if (left.samples !== null || right.samples !== null) {
      throw new Error("Operands for '~' must be exact scalar values");
    }
    const a = left.mean;
    const b = right.mean;
    const mean = (a + b) / 2;
    const stdDev = Math.abs(b - a) / 3.28970725;
    return createCurrencyValue(
      "scalar",
      mean,
      Math.min(a, b),
      Math.max(a, b),
      generateSamples(mean, stdDev, sampleCount),
    );
  }

  if (operator === "+" || operator === "-") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      const mean = operator === "+" ? left.mean + right.mean : left.mean - right.mean;
      const min = operator === "+" ? left.min + right.min : left.min - right.max;
      const max = operator === "+" ? left.max + right.max : left.max - right.min;
      const samples = operateSamples(left.samples ?? left.mean, right.samples ?? right.mean, operator, sampleCount);
      return createCurrencyValue("scalar", mean, min, max, samples);
    }

    if (left.kind === "money" && right.kind === "money") {
      const rightInLeftCurrency =
        right.currency === left.currency ? right : convertCurrencyValue(right, left.currency, rates);
      const meanRaw = operator === "+" ? left.mean + rightInLeftCurrency.mean : left.mean - rightInLeftCurrency.mean;
      const minRaw = operator === "+" ? left.min + rightInLeftCurrency.min : left.min - rightInLeftCurrency.max;
      const maxRaw = operator === "+" ? left.max + rightInLeftCurrency.max : left.max - rightInLeftCurrency.min;
      const samples = operateSamples(
        left.samples ?? left.mean,
        rightInLeftCurrency.samples ?? rightInLeftCurrency.mean,
        operator,
        sampleCount,
      );

      return createCurrencyValue(
        "money",
        roundCurrencyValue(meanRaw),
        roundCurrencyValue(Math.min(minRaw, maxRaw)),
        roundCurrencyValue(Math.max(minRaw, maxRaw)),
        Array.isArray(samples) ? samples.map(roundCurrencyValue) : null,
        left.currency,
      );
    }

    throw new Error(`Cannot ${operator === "+" ? "add" : "subtract"} scalar and currency values`);
  }

  if (operator === "*") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      const bounds = getMulBounds(left.min, left.max, right.min, right.max);
      const samples = operateSamples(left.samples ?? left.mean, right.samples ?? right.mean, operator, sampleCount);
      return createCurrencyValue("scalar", left.mean * right.mean, bounds.min, bounds.max, samples);
    }

    if ((left.kind === "money" && right.kind === "scalar") || (left.kind === "scalar" && right.kind === "money")) {
      const money = left.kind === "money" ? left : right;
      const scalar = left.kind === "scalar" ? left : right;
      const bounds = getMulBounds(money.min, money.max, scalar.min, scalar.max);
      const samples = operateSamples(money.samples ?? money.mean, scalar.samples ?? scalar.mean, operator, sampleCount);
      return createCurrencyValue(
        "money",
        roundCurrencyValue(money.mean * scalar.mean),
        roundCurrencyValue(bounds.min),
        roundCurrencyValue(bounds.max),
        Array.isArray(samples) ? samples.map(roundCurrencyValue) : null,
        money.currency,
      );
    }

    throw new Error("Multiplying two currency values is not supported");
  }

  if (operator === "/") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      const bounds = getDivBounds(left.min, left.max, right.min, right.max);
      const mean = right.mean === 0 ? NaN : left.mean / right.mean;
      const samples = operateSamples(left.samples ?? left.mean, right.samples ?? right.mean, operator, sampleCount);
      return createCurrencyValue("scalar", mean, bounds.min, bounds.max, samples);
    }

    if (left.kind === "money" && right.kind === "scalar") {
      const bounds = getDivBounds(left.min, left.max, right.min, right.max);
      const mean = roundCurrencyValue(right.mean === 0 ? NaN : left.mean / right.mean);
      const samples = operateSamples(left.samples ?? left.mean, right.samples ?? right.mean, operator, sampleCount);
      return createCurrencyValue(
        "money",
        mean,
        roundCurrencyValue(bounds.min),
        roundCurrencyValue(bounds.max),
        Array.isArray(samples) ? samples.map(roundCurrencyValue) : null,
        left.currency,
      );
    }

    if (left.kind === "money" && right.kind === "money") {
      const bounds = getDivBounds(left.min, left.max, right.min, right.max);
      const mean = right.mean === 0 ? NaN : left.mean / right.mean;
      const samples = operateSamples(left.samples ?? left.mean, right.samples ?? right.mean, operator, sampleCount);
      return createCurrencyValue("scalar", mean, bounds.min, bounds.max, samples);
    }

    throw new Error("Cannot divide scalar by a currency value");
  }

  if (operator === "^") {
    if (left.kind === "scalar" && right.kind === "scalar") {
      const bounds = getPowBounds(left.min, left.max, right.min, right.max);
      const samples = operateSamples(left.samples ?? left.mean, right.samples ?? right.mean, operator, sampleCount);
      return createCurrencyValue("scalar", Math.pow(left.mean, right.mean), bounds.min, bounds.max, samples);
    }

    if (left.kind === "money" && right.kind === "scalar") {
      const bounds = getPowBounds(left.min, left.max, right.min, right.max);
      const samples = operateSamples(left.samples ?? left.mean, right.samples ?? right.mean, operator, sampleCount);
      return createCurrencyValue(
        "money",
        roundCurrencyValue(Math.pow(left.mean, right.mean)),
        roundCurrencyValue(bounds.min),
        roundCurrencyValue(bounds.max),
        Array.isArray(samples) ? samples.map(roundCurrencyValue) : null,
        left.currency,
      );
    }

    throw new Error("Power is supported for scalar^scalar or money^scalar only");
  }

  throw new Error(`Unsupported operator '${operator}'`);
}

function evaluateCurrencyAstWithUncertainty(node, rates, sampleCount, baseValue = null) {
  if (isLiteralNode(node)) return createCurrencyValueFromLiteral(node);

  if (node.type === "base") {
    if (!baseValue) throw new Error("Base token was used without a replacement value");
    return cloneCurrencyValue(baseValue);
  }

  if (node.type === "unary") {
    if (node.operator !== "-") throw new Error(`Unsupported unary operator '${node.operator}'`);
    const value = evaluateCurrencyAstWithUncertainty(node.value, rates, sampleCount, baseValue);
    const min = Math.min(-value.max, -value.min);
    const max = Math.max(-value.max, -value.min);
    const mean = -value.mean;
    const samples = Array.isArray(value.samples) ? value.samples.map((entry) => -entry) : null;

    if (value.kind === "money") {
      return createCurrencyValue(
        "money",
        roundCurrencyValue(mean),
        roundCurrencyValue(min),
        roundCurrencyValue(max),
        Array.isArray(samples) ? samples.map(roundCurrencyValue) : null,
        value.currency,
      );
    }

    return createCurrencyValue("scalar", mean, min, max, samples);
  }

  if (node.type === "binary") {
    const left = evaluateCurrencyAstWithUncertainty(node.left, rates, sampleCount, baseValue);
    const right = evaluateCurrencyAstWithUncertainty(node.right, rates, sampleCount, baseValue);
    return evaluateCurrencyBinaryWithUncertainty(node.operator, left, right, rates, sampleCount);
  }

  throw new Error(`Unsupported AST node type '${node.type}'`);
}

function reduceCurrencyAstOneLayer(node, rates) {
  if (isLiteralNode(node) || node.type === "base") {
    return { node, changed: false };
  }

  if (node.type === "unary") {
    const reducedValue = reduceCurrencyAstOneLayer(node.value, rates);
    const nextNode = { type: "unary", operator: node.operator, value: reducedValue.node };
    if (reducedValue.changed) return { node: nextNode, changed: true };
    if (isLiteralNode(nextNode.value)) return { node: evaluateCurrencyUnary(nextNode), changed: true };
    return { node: nextNode, changed: false };
  }

  if (node.type === "binary") {
    const reducedLeft = reduceCurrencyAstOneLayer(node.left, rates);
    const reducedRight = reduceCurrencyAstOneLayer(node.right, rates);
    const nextNode = {
      type: "binary",
      operator: node.operator,
      left: reducedLeft.node,
      right: reducedRight.node,
    };

    if (reducedLeft.changed || reducedRight.changed) {
      return { node: nextNode, changed: true };
    }
    if (isLiteralNode(nextNode.left) && isLiteralNode(nextNode.right)) {
      return { node: evaluateCurrencyBinary(nextNode, rates), changed: true };
    }
    return { node: nextNode, changed: false };
  }

  throw new Error(`Unsupported AST node type '${node.type}'`);
}

function getCurrencyAstPrecedence(node) {
  if (node.type === "unary") return 5;
  if (node.type === "binary") {
    if (node.operator === "+" || node.operator === "-") return 1;
    if (node.operator === "*" || node.operator === "/") return 2;
    if (node.operator === "^") return 3;
    if (node.operator === "~") return 4;
  }
  return 99;
}

function formatCurrencyLiteral(node) {
  if (node.kind === "money") return `${formatCurrencyAmount(node.value)}${node.currency}`;
  return formatScalarAmount(node.value);
}

function formatCurrencyAst(node, parentPrecedence = 0, isRightChild = false, parentOperator = null) {
  if (isLiteralNode(node)) return formatCurrencyLiteral(node);
  if (node.type === "base") return BASE_CURRENCY_TOKEN;

  if (node.type === "unary") {
    const selfPrecedence = getCurrencyAstPrecedence(node);
    let valueText = formatCurrencyAst(node.value, 0, true, node.operator);
    const valuePrecedence = getCurrencyAstPrecedence(node.value);
    if (valuePrecedence < selfPrecedence) valueText = `(${valueText})`;
    let rendered = `-${valueText}`;
    if (selfPrecedence < parentPrecedence) return `(${rendered})`;
    return rendered;
  }

  if (node.type === "binary") {
    const selfPrecedence = getCurrencyAstPrecedence(node);

    let leftText = formatCurrencyAst(node.left, 0, false, node.operator);
    const leftPrecedence = getCurrencyAstPrecedence(node.left);
    if (leftPrecedence < selfPrecedence) leftText = `(${leftText})`;
    if (node.operator === "^" && leftPrecedence === selfPrecedence) leftText = `(${leftText})`;

    let rightText = formatCurrencyAst(node.right, 0, true, node.operator);
    const rightPrecedence = getCurrencyAstPrecedence(node.right);
    const needsRightWrap =
      rightPrecedence < selfPrecedence ||
      (rightPrecedence === selfPrecedence && (node.operator === "-" || node.operator === "/" || node.operator === "^"));
    if (needsRightWrap) rightText = `(${rightText})`;

    let rendered = `${leftText} ${node.operator} ${rightText}`;
    const parentRequiresWrap =
      selfPrecedence < parentPrecedence ||
      (isRightChild && parentOperator === "^" && selfPrecedence === parentPrecedence);

    if (parentRequiresWrap) rendered = `(${rendered})`;
    return rendered;
  }

  throw new Error(`Unsupported AST node for formatting: ${node.type}`);
}

function replaceBaseNode(node, replacement) {
  if (node.type === "base") return cloneCurrencyNode(replacement);
  if (isLiteralNode(node)) return cloneCurrencyNode(node);
  if (node.type === "unary") {
    return { type: "unary", operator: node.operator, value: replaceBaseNode(node.value, replacement) };
  }
  if (node.type === "binary") {
    return {
      type: "binary",
      operator: node.operator,
      left: replaceBaseNode(node.left, replacement),
      right: replaceBaseNode(node.right, replacement),
    };
  }
  throw new Error(`Unsupported node for base replacement: ${node.type}`);
}

function evaluateCurrencyExpressionWithSteps(expression, sampleCountOrOptions = DEFAULT_SAMPLES, maybeOptions = {}) {
  let sampleCount = DEFAULT_SAMPLES;
  let options = maybeOptions;
  if (typeof sampleCountOrOptions === "number") {
    sampleCount = sampleCountOrOptions;
  } else {
    options = sampleCountOrOptions || {};
  }

  const tokens = lexCurrencyExpression(expression);
  const topLevelToIndex = findTopLevelToToken(tokens);
  const hasRangeOperator = tokens.some((token) => token.type === "operator" && token.value === "~");
  const hasAdjacentCurrencySuffix = tokens.some(
    (token, idx) =>
      token.type === "number" &&
      tokens[idx + 1] &&
      tokens[idx + 1].type === "identifier" &&
      tokens[idx + 1].value !== BASE_CURRENCY_TOKEN,
  );
  const hasGroupedCurrencySuffix = tokens.some(
    (token, idx) =>
      token.type === "operator" &&
      token.value === ")" &&
      tokens[idx + 1] &&
      tokens[idx + 1].type === "identifier" &&
      tokens[idx + 1].value !== BASE_CURRENCY_TOKEN,
  );
  const looksLikeCurrencyExpression =
    topLevelToIndex >= 0 ||
    tokens.some((token) => token.type === "money") ||
    hasAdjacentCurrencySuffix ||
    hasGroupedCurrencySuffix;

  if (!looksLikeCurrencyExpression) return null;

  const rates = buildCurrencyRateMap(options.currencyRates);
  const leftTokens = topLevelToIndex >= 0 ? tokens.slice(0, topLevelToIndex) : tokens;
  if (leftTokens.length === 0) throw new Error("Missing expression before currency conversion");

  let targetCurrency = null;
  let tailTokens = [];
  let tailAst = null;
  if (topLevelToIndex >= 0) {
    const targetToken = tokens[topLevelToIndex + 1];
    if (!targetToken || targetToken.type !== "identifier") {
      throw new Error("Expected target currency after 'to'");
    }
    targetCurrency = targetToken.value;
    tailTokens = tokens.slice(topLevelToIndex + 2);
    if (tailTokens.length > 0) {
      const tailExpressionTokens = [
        { type: "identifier", value: BASE_CURRENCY_TOKEN, raw: BASE_CURRENCY_TOKEN },
        ...tailTokens,
      ];
      tailAst = parseCurrencyExpressionTokens(tailExpressionTokens, {
        allowBaseToken: true,
        allowCurrencySuffix: true,
      });
    }
  }

  const leftAst = parseCurrencyExpressionTokens(leftTokens, { allowBaseToken: false, allowCurrencySuffix: true });
  const conversionSuffix = targetCurrency
    ? `to ${targetCurrency}${tailTokens.length > 0 ? ` ${formatTokenSequence(tailTokens)}` : ""}`
    : "";

  const appendSuffix = (content) => (conversionSuffix ? `${content} ${conversionSuffix}` : content);

  const steps = [];
  let reducedLeft = leftAst;
  steps.push(appendSuffix(formatCurrencyAst(reducedLeft)));

  while (!isLiteralNode(reducedLeft)) {
    const next = reduceCurrencyAstOneLayer(reducedLeft, rates);
    if (!next.changed) throw new Error("Unable to simplify expression");
    reducedLeft = next.node;
    steps.push(appendSuffix(formatCurrencyAst(reducedLeft)));
  }

  let finalAst = reducedLeft;
  if (targetCurrency) {
    finalAst = convertLiteralCurrency(finalAst, targetCurrency, rates);

    if (tailAst) {
      finalAst = replaceBaseNode(tailAst, finalAst);
      steps.push(formatCurrencyAst(finalAst));

      while (!isLiteralNode(finalAst)) {
        const next = reduceCurrencyAstOneLayer(finalAst, rates);
        if (!next.changed) throw new Error("Unable to simplify post-conversion expression");
        finalAst = next.node;
        steps.push(formatCurrencyAst(finalAst));
      }
    } else {
      steps.push(formatCurrencyAst(finalAst));
    }
  }

  if (!isLiteralNode(finalAst)) throw new Error("Expression did not simplify to a single value");

  const resultCurrency = finalAst.kind === "money" ? finalAst.currency : null;
  let sampledResult = null;
  if (hasRangeOperator) {
    sampledResult = evaluateCurrencyAstWithUncertainty(leftAst, rates, sampleCount);

    if (targetCurrency) {
      sampledResult = convertCurrencyValue(sampledResult, targetCurrency, rates);
      if (tailAst) {
        sampledResult = evaluateCurrencyAstWithUncertainty(tailAst, rates, sampleCount, sampledResult);
      }
    }
  }

  return {
    isCurrencyExpression: true,
    currency: resultCurrency,
    steps,
    result: {
      mean: sampledResult ? sampledResult.mean : finalAst.value,
      min: sampledResult ? sampledResult.min : finalAst.value,
      max: sampledResult ? sampledResult.max : finalAst.value,
      samples: sampledResult ? sampledResult.samples : null,
      currency: resultCurrency,
      display: finalAst.kind === "money" ? `${formatCurrencyAmount(finalAst.value, true)}${resultCurrency}` : formatNumber(finalAst.value),
    },
  };
}

function evaluateExpressionWithSteps(expression, sampleCount = DEFAULT_SAMPLES, options = {}) {
  const currencyResult = evaluateCurrencyExpressionWithSteps(expression, sampleCount, options);
  if (currencyResult) return currencyResult;

  const result = evaluateExpression(expression, sampleCount);
  return {
    isCurrencyExpression: false,
    currency: null,
    steps: [],
    result,
  };
}

// Return 5th and 95th percentiles from sample array, ignoring NaN/Inf
function getQuantiles(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { p05: NaN, p95: NaN };
  const validSamples = samples.filter((n) => !isNaN(n) && isFinite(n));
  if (validSamples.length === 0) return { p05: NaN, p95: NaN };
  const sorted = [...validSamples].sort((a, b) => a - b);
  const len = sorted.length;
  const p05Index = Math.max(0, Math.floor(0.05 * len) - 1);
  const p95Index = Math.min(len - 1, Math.ceil(0.95 * len) - 1);
  return {
    p05: sorted[p05Index],
    p95: sorted[p95Index],
  };
}

// Nicely format numbers with adaptive precision and optional left padding
function formatNumber(num, padWidth = 0) {
  let str;
  const absNum = Math.abs(num);

  if (isNaN(num)) str = "NaN";
  else if (!isFinite(num)) str = num > 0 ? "Infinity" : "-Infinity";
  else if (absNum === 0) str = "0";
  else if (absNum < 1e-6 || absNum >= 1e9) str = num.toExponential(4);
  else {
    let decimals;
    if (absNum >= 1000) decimals = 1;
    else if (absNum >= 100) decimals = 2;
    else if (absNum >= 10) decimals = 3;
    else if (absNum >= 1) decimals = 4;
    else if (absNum >= 0.01) decimals = 5;
    else decimals = 6;

    str = num.toFixed(decimals);
    str = str.replace(/\.$/, "");
  }
  return padWidth > 0 ? str.padStart(padWidth) : str;
}

// Average of valid numeric samples; returns NaN if no usable values
function calculateSampleMean(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return NaN;
  const validSamples = samples.filter((n) => !isNaN(n) && isFinite(n));
  if (validSamples.length === 0) return NaN;
  const sum = validSamples.reduce((acc, val) => acc + val, 0);
  return sum / validSamples.length;
}

// Build text lines for a simple histogram of sample distribution
function generateTextHistogram(samples, options = {}) {
  const numBins = options.bins ?? DEFAULT_BINS;
  const maxBarWidth = options.width ?? DEFAULT_WIDTH;
  const barChar = (options.barChar ?? DEFAULT_BAR).slice(0, 1) || DEFAULT_BAR;
  const output = [];
  if (!Array.isArray(samples) || samples.length === 0) return ["Histogram unavailable (no samples)."];

  const validSamples = samples.filter((n) => !isNaN(n) && isFinite(n));
  if (validSamples.length === 0) return ["Cannot generate histogram (no valid numeric samples)."];

  const minVal = Math.min(...validSamples);
  const maxVal = Math.max(...validSamples);
  const sampleMean = calculateSampleMean(validSamples);

  if (minVal === maxVal) {
    const label = formatNumber(minVal, 7);
    output.push(`${label} | ${barChar.repeat(maxBarWidth)} (all samples)`);
    return output;
  }

  const binSize = (maxVal - minVal) / numBins;
  const binCounts = Array(numBins).fill(0);
  for (const sample of validSamples) {
    let binIndex = binSize === 0 ? 0 : Math.floor((sample - minVal) / binSize);
    if (binIndex >= numBins) binIndex = numBins - 1;
    if (binIndex < 0) binIndex = 0;
    binCounts[binIndex]++;
  }

  const maxCount = Math.max(...binCounts);
  if (maxCount === 0) return ["Cannot generate histogram (counts are zero)."];

  let meanBinIndex = binSize === 0 ? 0 : Math.floor((sampleMean - minVal) / binSize);
  if (meanBinIndex >= numBins) meanBinIndex = numBins - 1;
  if (meanBinIndex < 0) meanBinIndex = 0;

  for (let i = numBins - 1; i >= 0; i--) {
    const binStart = minVal + i * binSize;
    const count = binCounts[i];
    const barWidth = maxCount === 0 ? 0 : Math.round((count / maxCount) * maxBarWidth);
    const bar = barChar.repeat(barWidth);
    const label = formatNumber(binStart, 7);

    let line = `${label} | ${bar}`;
    if (i === meanBinIndex) {
      line += ` (mean≈${formatNumber(sampleMean)})`;
    }
    output.push(line);
  }
  return output;
}

const core = {
  DEFAULT_SAMPLES,
  DEFAULT_BINS,
  DEFAULT_WIDTH,
  DEFAULT_BAR,
  tokenize,
  shuntingYard,
  evalRpn,
  evaluateExpression,
  evaluateExpressionWithSteps,
  evaluateCurrencyExpressionWithSteps,
  getQuantiles,
  formatNumber,
  generateTextHistogram,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = core;
}
if (typeof window !== "undefined") {
  window.UnsureCalcCore = core;
}
