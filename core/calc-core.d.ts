export type Token = number | string;
export type UncertainValue = {
  mean: number;
  min: number;
  max: number;
  samples: number[] | null;
};

export type CurrencyResult = UncertainValue & {
  currency: string | null;
  display: string;
};

export type EvaluationWithSteps = {
  isCurrencyExpression: boolean;
  currency: string | null;
  steps: string[];
  result: (UncertainValue & { currency?: undefined; display?: undefined }) | CurrencyResult | null;
};

export type Quantiles = { p05: number; p95: number };

export type HistogramOptions = {
  bins?: number;
  width?: number;
  barChar?: string;
};

export type HistogramBin = { start: number; end: number; count: number };
export type Histogram = {
  bins: HistogramBin[];
  maxCount: number;
  meanBinIndex: number;
  sampleMean: number;
  sampleCount: number;
  validCount: number;
  belowCount: number;
  minVal: number;
  maxVal: number;
};

export const DEFAULT_SAMPLES: number;
export const DEFAULT_BINS: number;
export const DEFAULT_WIDTH: number;
export const DEFAULT_BAR: string;
export const DEFAULT_SEED: number;

export function tokenize(s: string): Token[];
export function shuntingYard(tokens: Token[]): Token[];
export function evalRpn(rpnQueue: Token[], sampleCount?: number): UncertainValue | null;
export function evaluateExpression(expression: string, sampleCount?: number): UncertainValue | null;
export function evaluateCurrencyExpressionWithSteps(
  expression: string,
  sampleCountOrOptions?: number | { currencyRates?: Record<string, Record<string, number>> },
  options?: { currencyRates?: Record<string, Record<string, number>> },
): EvaluationWithSteps | null;
export function evaluateExpressionWithSteps(
  expression: string,
  sampleCount?: number,
  options?: { currencyRates?: Record<string, Record<string, number>> },
): EvaluationWithSteps;
export function getQuantiles(samples: number[] | null): Quantiles;
export function sortedValidSamples(samples: number[] | null): number[];
export function percentileOfSorted(sorted: number[], percent: number): number;
export function percentRankOfSorted(sorted: number[], value: number): number;
export function niceTicks(min: number, max: number, targetCount?: number): { ticks: number[]; step: number; decimals: number };
export function formatNumber(num: number, padWidth?: number): string;
export function generateTextHistogram(samples: number[] | null, options?: HistogramOptions): string[];
export function computeHistogramBins(
  samples: number[] | null,
  options?: { bins?: number; trim?: number },
): Histogram | null;

export type StepToken =
  | { type: "number"; text: string; value: string; unit: string }
  | { type: "unit" | "keyword" | "operator" | "paren"; text: string };

export function tokenizeStep(step: string): StepToken[];
export function diffStepTokens(prev: StepToken[], next: StepToken[]): boolean[];
