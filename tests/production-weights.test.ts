import { parse } from '@babel/parser';
import { Generator } from '../src/generator';
import { printProgram } from '../src/generator/printer';
import { JsGrammar, ProductionKey } from '../src/generator/js-grammar';

const PARSER_OPTIONS = { sourceType: 'script' as const };

const BASE_KEYS: ProductionKey[] = [
  'number', 'bigint', 'string', 'boolean', 'array', 'object', 'identifier',
  'binary', 'conditional', 'logical', 'unary', 'sequence', 'template',
  'call', 'memberRead', 'regExp', 'symbol', 'methodCall',
];

describe('production weights', () => {
  it('weightedIndex reduces to floor(r * N) for equal weights and partitions weighted inputs', () => {
    const grammar = new JsGrammar({}, 0);

    // Behavior-preservation invariant: with all-equal weights the helper
    // must return floor(r * N), byte-identical to the prior randint path.
    for (const n of [1, 2, 3, 5, 18, 20]) {
      const weights = new Array<number>(n).fill(1);
      for (let k = 0; k < 256; k++) {
        const r = k / 256;
        expect(grammar.weightedIndex(weights, r)).toBe(Math.floor(r * n));
      }
      // Boundaries: r = 0 selects the first bucket; r just under 1 the last.
      expect(grammar.weightedIndex(weights, 0)).toBe(0);
      expect(grammar.weightedIndex(weights, 0.9999999)).toBe(n - 1);
    }

    // Weighted partitioning: weights [1, 3, 1] total 5, so bucket 1 covers
    // r in [0.2, 0.8).
    const w = [1, 3, 1];
    expect(grammar.weightedIndex(w, 0.1)).toBe(0);
    expect(grammar.weightedIndex(w, 0.3)).toBe(1);
    expect(grammar.weightedIndex(w, 0.7)).toBe(1);
    expect(grammar.weightedIndex(w, 0.9)).toBe(2);
  });

  it('default config is deterministic across seeds and stays parseable at greater depth', () => {
    // Determinism sanity: the same seed must reproduce the same program.
    const first = printProgram(new Generator({ mode: 'js-only', seed: 7 }).generate());
    const second = printProgram(new Generator({ mode: 'js-only', seed: 7 }).generate());
    expect(second).toBe(first);

    // Raising maxExpressionDepth must still yield valid, parseable JS.
    const deeper = printProgram(
      new Generator({ mode: 'js-only', seed: 7, js: { maxExpressionDepth: 12 } }).generate(),
    );
    expect(() => parse(deeper, PARSER_OPTIONS)).not.toThrow();
  });

  it('skews the realized distribution toward a heavily weighted production', () => {
    const totals: Partial<Record<ProductionKey, number>> = {};
    for (let seed = 0; seed < 200; seed++) {
      const grammar = new JsGrammar({ productionWeights: { number: 1000 } }, seed);
      grammar.resetProductionCounts();
      grammar.generateProgram();
      for (const [key, value] of Object.entries(grammar.getProductionCounts()) as Array<
        [ProductionKey, number | undefined]
      >) {
        totals[key] = (totals[key] ?? 0) + (value ?? 0);
      }
    }

    const numberCount = totals['number'] ?? 0;
    const otherCounts = BASE_KEYS.filter((k) => k !== 'number').map(
      (k) => totals[k] ?? 0,
    );
    const otherBaseTotal = otherCounts.reduce((sum, c) => sum + c, 0);
    const maxOther = Math.max(...otherCounts);

    // 'number' is the plurality production.
    expect(numberCount).toBeGreaterThan(maxOther);

    // With weight 1000 vs 1 for each of ~17 others, 'number' dominates: it
    // out-selects all other base productions combined by a wide margin.
    // (Spec: at least ~5x the least-selected base production; comparing
    // against the combined other-total is a stronger, non-flaky form.)
    expect(numberCount).toBeGreaterThan(otherBaseTotal);
    expect(numberCount).toBeGreaterThanOrEqual(5 * otherBaseTotal);
  });

  it('tallies per-production counters that reset zeroes', () => {
    const grammar = new JsGrammar({}, 0);

    grammar.resetProductionCounts();
    expect(Object.keys(grammar.getProductionCounts())).toHaveLength(0);

    grammar.generateProgram();
    const counts = grammar.getProductionCounts();
    const entries = Object.entries(counts);
    expect(entries.length).toBeGreaterThan(0);
    const sum = entries.reduce((acc, [, value]) => acc + (value ?? 0), 0);
    expect(sum).toBeGreaterThan(0);

    grammar.resetProductionCounts();
    expect(Object.keys(grammar.getProductionCounts())).toHaveLength(0);
  });
});
