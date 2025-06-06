import type { TrieCost, WeightMap } from '../distance/weightedMaps.js';
import type { ITrieNode, TrieOptionsRO } from '../ITrieNode/index.js';
import { CompoundWordsMethod, JOIN_SEPARATOR, WORD_SEPARATOR } from '../ITrieNode/walker/index.js';
import type { TrieData } from '../TrieData.js';
import { PairingHeap } from '../utils/PairingHeap.js';
import { opCosts } from './constants.js';
import type { SuggestionOptionsRO } from './genSuggestionsOptions.js';
import { createSuggestionOptions } from './genSuggestionsOptions.js';
import { visualLetterMaskMap } from './orthography.js';
import { suggestionCollector } from './suggestCollector.js';
import type { SuggestionGenerator, SuggestionResult } from './SuggestionTypes.js';

type RO<T> = Readonly<T>;

type Cost = number;
// type BranchIdx = number;
type WordIndex = number;

/** A Trie structure used to track accumulated costs */
interface CostTrie {
    /** cost by index */
    c: number[];
    t: Record<string, CostTrie | undefined>;
}

interface PNode {
    /** current node */
    n: ITrieNode;
    /** Accumulated cost */
    c: Cost;
    /** Index into src word */
    i: WordIndex;
    /** letter used or '' */
    s: string;
    /** parent node */
    p: PNode | undefined;
    /** cost trie to reduce duplicate paths */
    t: CostTrie;
    /** edit action taken */
    a?: string | undefined;
}

// const ProgressFactor = opCosts.baseCost - 1;

/**
 * Compare Path Nodes.
 * Balance the calculation between depth vs cost
 */
function comparePath(a: PNode, b: PNode): number {
    return a.c / (a.i + 1) - b.c / (b.i + 1) + (b.i - a.i);
}

export function suggestAStar(trie: TrieData, word: string, options: SuggestionOptionsRO = {}): SuggestionResult[] {
    const opts = createSuggestionOptions(options);
    const collector = suggestionCollector(word, opts);
    collector.collect(getSuggestionsAStar(trie, word, opts));
    return collector.suggestions;
}

export function* getSuggestionsAStar(
    trie: TrieData,
    srcWord: string,
    options: SuggestionOptionsRO = {},
): SuggestionGenerator {
    const { compoundMethod, changeLimit, ignoreCase, weightMap } = createSuggestionOptions(options);
    const visMap = visualLetterMaskMap;
    const root = trie.getRoot();
    const rootIgnoreCase = (ignoreCase && root.get(root.info.stripCaseAndAccentsPrefix)) || undefined;
    const pathHeap = new PairingHeap(comparePath);
    const resultHeap = new PairingHeap(compareSuggestion);
    const rootPNode: PNode = { n: root, i: 0, c: 0, s: '', p: undefined, t: createCostTrie() };
    const BC = opCosts.baseCost;
    const VC = opCosts.visuallySimilar;
    const DL = opCosts.duplicateLetterCost;
    const wordSeparator = compoundMethod === CompoundWordsMethod.JOIN_WORDS ? JOIN_SEPARATOR : WORD_SEPARATOR;
    const sc = specialChars(trie.info);
    const comp = trie.info.compoundCharacter;
    const compRoot = root.get(comp);
    const compRootIgnoreCase = rootIgnoreCase && rootIgnoreCase.get(comp);
    const emitted: Record<string, number> = Object.create(null);

    const srcLetters = [...srcWord];

    /** Initial limit is based upon the length of the word. */
    let limit = BC * Math.min(srcLetters.length * opCosts.wordLengthCostFactor, changeLimit);

    pathHeap.add(rootPNode);
    if (rootIgnoreCase) {
        pathHeap.add({ n: rootIgnoreCase, i: 0, c: 0, s: '', p: undefined, t: createCostTrie() });
    }

    let best = pathHeap.dequeue();
    let maxSize = pathHeap.size;
    let suggestionsGenerated = 0;
    let nodesProcessed = 0;
    let nodesProcessedLimit = 1000;
    let minGen = 1;
    while (best) {
        if (++nodesProcessed > nodesProcessedLimit) {
            nodesProcessedLimit += 1000;
            if (suggestionsGenerated < minGen) {
                break;
            }
            minGen += suggestionsGenerated;
            // nodesProcessed >>= 1;
            // suggestionsGenerated >>= 1;
        }
        if (best.c > limit) {
            // break;
            best = pathHeap.dequeue();
            maxSize = Math.max(maxSize, pathHeap.size);
            continue;
        }
        processPath(best);

        for (const sug of resultHeap) {
            ++suggestionsGenerated;
            if (sug.cost > limit) continue;
            if (sug.word in emitted && emitted[sug.word] <= sug.cost) continue;
            // console.warn('%o', sug);
            const action = yield sug;
            emitted[sug.word] = sug.cost;
            if (typeof action === 'number') {
                // console.log('%o', { limit, newLimit: action, sug });
                limit = Math.min(action, limit);
            }
            if (typeof action === 'symbol') {
                return;
            }
        }

        best = pathHeap.dequeue();
        maxSize = Math.max(maxSize, pathHeap.size);
    }
    // console.log('%o', { maxSize, suggestionsGenerated, nodesProcessed });

    return;

    function compareSuggestion(a: SuggestionResult, b: SuggestionResult): number {
        const pa = (a.isPreferred && 1) || 0;
        const pb = (b.isPreferred && 1) || 0;
        return (
            pb - pa ||
            a.cost - b.cost ||
            // eslint-disable-next-line unicorn/prefer-code-point
            Math.abs(a.word.charCodeAt(0) - srcWord.charCodeAt(0)) -
                // eslint-disable-next-line unicorn/prefer-code-point
                Math.abs(b.word.charCodeAt(0) - srcWord.charCodeAt(0))
        );
    }

    function processPath(p: PNode) {
        const len = srcLetters.length;

        if (p.n.eow && p.i === len) {
            const word = pNodeToWord(p);
            const result = { word, cost: p.c };
            resultHeap.add(result);
        }

        calcEdges(p);
    }

    function calcEdges(p: PNode): void {
        const { n, i, t } = p;
        const s = srcLetters[i];
        const sg = visMap[s] || 0;
        const cost0 = p.c;
        const cost = cost0 + BC + (i ? 0 : opCosts.firstLetterBias);
        const costVis = cost0 + VC;
        const costLegacyCompound = cost0 + opCosts.wordBreak;
        const costCompound = cost0 + opCosts.compound;
        if (s) {
            // Match
            const m = n.get(s);
            if (m) {
                storePath(t, m, i + 1, cost0, s, p, '=', s);
            }

            if (weightMap) {
                processWeightMapEdges(p, weightMap);
            }

            // Double letter, delete 1
            const ns = srcLetters[i + 1];
            if (s == ns && m) {
                storePath(t, m, i + 2, cost0 + DL, s, p, 'dd', s);
            }
            // Delete
            storePath(t, n, i + 1, cost, '', p, 'd', '');

            // Replace
            for (const [ss, node] of n.entries()) {
                if (node.id === m?.id || ss in sc) continue;
                const g = visMap[ss] || 0;
                // srcWord === 'WALK' && console.log(g.toString(2));
                const c = sg & g ? costVis : cost;
                storePath(t, node, i + 1, c, ss, p, 'r', ss);
            }

            if (n.eow && i && compoundMethod) {
                // legacy word compound
                storePath(t, root, i, costLegacyCompound, wordSeparator, p, 'L', wordSeparator);
            }

            // swap
            if (ns) {
                const n1 = n.get(ns);
                const n2 = n1?.get(s);
                if (n2) {
                    const ss = ns + s;
                    storePath(t, n2, i + 2, cost0 + opCosts.swapCost, ss, p, 's', ss);
                }
            }
        }

        // Natural Compound
        if (compRoot && costCompound <= limit && n.get(comp)) {
            if (compRootIgnoreCase) {
                storePath(t, compRootIgnoreCase, i, costCompound, '', p, '~+', '~+');
            }
            storePath(t, compRoot, i, costCompound, '', p, '+', '+');
        }

        // Insert
        if (cost <= limit) {
            // At the end of the word, only append is possible.
            for (const [char, node] of n.entries()) {
                if (char in sc) continue;
                storePath(t, node, i, cost, char, p, 'i', char);
            }
        }
    }

    function processWeightMapEdges(p: PNode, weightMap: WeightMap) {
        delLetters(p, weightMap, srcLetters, storePath);
        insLetters(p, weightMap, srcLetters, storePath);
        repLetters(p, weightMap, srcLetters, storePath);
        return;
    }

    /**
     * Apply a cost to the current step.
     * @param t - trie node
     * @param s - letter to apply, empty string means to apply to the current node
     * @param i - index
     * @param c - cost
     * @returns PNode if it was applied, otherwise undefined
     */
    function storePath(
        t: CostTrie,
        n: ITrieNode,
        i: number,
        c: number,
        s: string,
        p: PNode,
        a: string,
        ss: string,
    ): void {
        const tt = getCostTrie(t, ss);
        const curr = tt.c[i];
        if (curr <= c || c > limit) return undefined;
        tt.c[i] = c;
        pathHeap.add({ n, i, c, s, p, t: tt, a });
    }
}

function delLetters(pNode: PNode, weightMap: WeightMap, letters: string[], storePath: FnStorePath) {
    const { t, n } = pNode;
    const trie = weightMap.insDel;
    let ii = pNode.i;
    const cost0 = pNode.c - pNode.i;

    const len = letters.length;

    for (let nn = trie.n; ii < len && nn; ) {
        const tt = nn[letters[ii]];
        if (!tt) return;
        ++ii;
        if (tt.c !== undefined) {
            storePath(t, n, ii, cost0 + tt.c, '', pNode, 'd', '');
        }
        nn = tt.n;
    }
}

function insLetters(p: PNode, weightMap: WeightMap, _letters: string[], storePath: FnStorePath) {
    const { t, i, c, n } = p;
    const cost0 = c;

    searchTrieCostNodesMatchingTrie2(weightMap.insDel, n, (s, tc, n) => {
        if (tc.c !== undefined) {
            storePath(t, n, i, cost0 + tc.c, s, p, 'i', s);
        }
    });
}

function repLetters(pNode: RO<PNode>, weightMap: WeightMap, letters: string[], storePath: FnStorePath) {
    const node = pNode.n;
    const pt = pNode.t;
    const cost0 = pNode.c;
    const len = letters.length;
    const trie = weightMap.replace;
    let i = pNode.i;

    for (let n = trie.n; i < len && n; ) {
        const t = n[letters[i]];
        if (!t) return;
        ++i;
        // yield { i, t };
        const tInsert = t.t;
        if (tInsert) {
            searchTrieCostNodesMatchingTrie2<TrieCost>(tInsert, node, (s, tt, n) => {
                const c = tt.c;
                if (c === undefined) {
                    return;
                }
                storePath(pt, n, i, cost0 + c + (tt.p || 0), s, pNode, 'r', s);
            });
        }
        n = t.n;
    }
}

function createCostTrie(): CostTrie {
    return { c: [], t: Object.create(null) };
}

function getCostTrie(t: RO<CostTrie>, s: string) {
    if (s.length == 1) {
        return (t.t[s] ??= createCostTrie());
    }
    if (!s) {
        return t;
    }
    let tt = t;
    for (const c of s) {
        tt = tt.t[c] ??= createCostTrie();
    }
    return tt;
}

function pNodeToWord(p: RO<PNode>): string {
    const parts: string[] = [];
    let n: RO<PNode> | undefined = p;
    while (n) {
        parts.push(n.s);
        n = n.p;
    }
    parts.reverse();
    return parts.join('');
}

function specialChars(options: TrieOptionsRO): Record<string, true | undefined> {
    const charSet: Record<string, true | undefined> = Object.create(null);
    for (const c of Object.values(options)) {
        if (typeof c === 'string') {
            charSet[c] = true;
        }
    }
    return charSet;
}

function orderNodes(p: RO<PNode>): PNode[] {
    const nodes: PNode[] = [];
    let n: PNode | undefined = p;
    while (n) {
        nodes.push(n);
        n = n.p;
    }
    return nodes.reverse();
}

function editHistory(p: RO<PNode>): Pick<PNode, 'i' | 'c' | 'a' | 's'>[] {
    const nodes = orderNodes(p);
    return nodes.map((n) => ({ i: n.i, c: n.c, a: n.a, s: n.s }));
}

function searchTrieCostNodesMatchingTrie2<T extends { n?: Record<string, T> }>(
    trie: T,
    node: ITrieNode,
    emit: (s: string, t: T, n: ITrieNode) => void,
    s = '',
): void {
    const n = trie.n;
    if (!n) return;
    for (const [key, c] of node.entries()) {
        const t = n[key];
        if (!t) continue;
        const pfx = s + key;
        emit(pfx, t, c);
        if (t.n) {
            searchTrieCostNodesMatchingTrie2(t, c, emit, pfx);
        }
    }
}

function prefixLines(content: string, prefix: string): string {
    return content
        .split('\n')
        .map((line) => prefix + line)
        .join('\n');
}

function serializeCostTrie(p: RO<PNode>): string {
    while (p.p) {
        p = p.p;
    }
    return _serializeCostTrie(p.t);
}

function _serializeCostTrie(t: RO<CostTrie>): string {
    const lines: string[] = [];
    lines.push(`:: [${t.c.join(',')}]`);
    for (const [letter, child] of Object.entries(t.t)) {
        lines.push(letter + ':');
        if (!child) continue;
        lines.push(prefixLines(_serializeCostTrie(child), '| '));
    }
    return lines.join('\n');
}

type FnStorePath = (
    t: CostTrie,
    n: ITrieNode,
    i: number,
    c: number,
    s: string,
    p: PNode,
    a: string,
    ss: string,
) => void;

export const __testing__: {
    comparePath: typeof comparePath;
    editHistory: typeof editHistory;
    serializeCostTrie: typeof serializeCostTrie;
} = {
    comparePath,
    editHistory,
    serializeCostTrie,
};
