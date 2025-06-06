import type { ExResult } from './distanceAStarWeighted.js';
import { distanceAStarWeightedEx } from './distanceAStarWeighted.js';
import { createWeightCostCalculator, type WeightMap } from './weightedMaps.js';

function pL(s: string, w: number) {
    const strWidth = vizWidth(s);
    const w0 = Math.max(0, w - strWidth);
    return ' '.repeat(w0) + s;
}

function pR(s: string, w: number) {
    const strWidth = vizWidth(s);
    const w0 = Math.max(0, w - strWidth);
    return s + ' '.repeat(w0);
}

function vizWidth(s: string) {
    const r = s.replaceAll(/[\u0300-\u036F\u007F-\u009F]/gu, '');
    let i = 0;
    for (const c of r) {
        i += c.length;
    }
    return i;
}

export function formatExResult(ex: ExResult | undefined): string {
    if (!ex) return '<undefined>';

    const { cost, segments, penalty } = ex;
    const asString = segments.map(({ a, b, c, p }) => ({
        a: `<${a}>`,
        b: `<${b}>`,
        c: c.toString(10),
        p: p.toString(10),
    }));
    asString.push({
        a: '',
        b: '',
        c: ' = ' + segments.reduce((sum, { c }) => sum + c, 0).toString(10),
        p: ' = ' + segments.reduce((sum, { p }) => sum + p, 0).toString(10),
    });
    const parts = asString.map(({ a, b, c, p }) => ({
        a,
        b,
        c,
        p,
        w: Math.max(vizWidth(a), vizWidth(b), vizWidth(c), vizWidth(p)),
    }));
    const a = 'a: |' + parts.map(({ a, w }) => pR(a, w)).join('|') + '|';
    const b = 'b: |' + parts.map(({ b, w }) => pR(b, w)).join('|') + '|';
    const c = 'c: |' + parts.map(({ c, w }) => pL(c, w)).join('|') + '|';
    const p = 'p: |' + parts.map(({ p, w }) => pL(p, w)).join('|') + '|';
    const penaltyMsg = penalty ? `[+${penalty}]` : '';
    return `<${ex.a.slice(1, -1)}> -> <${ex.b.slice(1, -1)}> (${cost - penalty}${penaltyMsg})\n${[a, b, c, p].join(
        '\n',
    )}\n`;
}

export function formattedDistance(wordA: string, wordB: string, weightMap: WeightMap, cost?: number): string {
    const calc = createWeightCostCalculator(weightMap);
    const distResult = distanceAStarWeightedEx(wordA, wordB, calc, cost);
    return formatExResult(distResult);
}
