import type { WeightMap } from '../distance/index.js';
import { editDistanceWeighted } from '../distance/index.js';
import { addDefToWeightMap } from '../distance/weightedMaps.js';
import type { RequireOptional } from '../types.js';
import { startTimer } from '../utils/timer.js';
import { clean, regexQuote, replaceAllFactory } from '../utils/util.js';
import { WORD_SEPARATOR } from '../walker/index.js';
import { DEFAULT_COMPOUNDED_WORD_SEPARATOR } from './constants.js';
import type { GenSuggestionOptionsRO, GenSuggestionOptionsStrictRO } from './genSuggestionsOptions.js';
import type {
    GenerateSuggestionResult,
    MaxCost,
    Progress,
    SuggestionGenerator,
    SuggestionResult,
    SuggestionResultBase,
} from './SuggestionTypes.js';

const defaultMaxNumberSuggestions = 10;

const BASE_COST = 100;
const MAX_NUM_CHANGES = 5;
const MAX_COST_SCALE = 0.5;
// max allowed cost scale should be a bit over 50% to allow for suggestions to short words, but not too high to have too many suggestions.
const MAX_ALLOWED_COST_SCALE = 1.03 * MAX_COST_SCALE;

const collator = new Intl.Collator();

// This is a bit broken, it was supposed to also include JOIN_SEPARATOR (`+`)
// Add it back later.
const regexSeparator = new RegExp(`[${regexQuote(WORD_SEPARATOR)}]`, 'g');

const wordLengthCost = [0, 50, 25, 5, 0];
const EXTRA_WORD_COST = 5;

/** time in ms */
const DEFAULT_COLLECTOR_TIMEOUT = 1000;

const symStopProcessing = Symbol('Collector Stop Processing');

// comparison function for Suggestion Results.
export function compSuggestionResults(a: SuggestionResultBase, b: SuggestionResultBase): number {
    const aPref = (a.isPreferred && -1) || 0;
    const bPref = (b.isPreferred && -1) || 0;
    return aPref - bPref || a.cost - b.cost || a.word.length - b.word.length || collator.compare(a.word, b.word);
}

export type FilterWordFn = (word: string, cost: number) => boolean;

export interface SuggestionCollector {
    /**
     * Collection suggestions from a SuggestionIterator
     * @param src - the SuggestionIterator used to generate suggestions.
     * @param timeout - the amount of time in milliseconds to allow for suggestions.
     * before sending `symbolStopProcessing`
     * Iterator implementation:
     * @example
     * r = yield(suggestion);
     * if (r === collector.symbolStopProcessing) // ...stop generating suggestions.
     */
    collect: (src: SuggestionGenerator, timeout?: number, filter?: FilterWordFn) => void;
    add: (suggestion: SuggestionResultBase) => SuggestionCollector;
    readonly suggestions: SuggestionResult[];
    readonly changeLimit: number;
    readonly maxCost: number;
    readonly word: string;
    readonly maxNumSuggestions: number;
    readonly includesTies: boolean;
    readonly ignoreCase: boolean;
    readonly genSuggestionOptions: GenSuggestionOptionsRO;
    /**
     * Possible value sent to the SuggestionIterator telling it to stop processing.
     */
    readonly symbolStopProcessing: symbol;
}

export interface SuggestionCollectorOptions extends Omit<GenSuggestionOptionsStrictRO, 'ignoreCase' | 'changeLimit'> {
    /**
     * number of best matching suggestions.
     * @default 10
     */
    numSuggestions: number;

    /**
     * An optional filter function that can be used to limit remove unwanted suggestions.
     * I.E. to remove forbidden terms.
     * @default () => true
     */
    filter?: FilterWordFn | undefined;

    /**
     * The number of letters that can be changed when looking for a match
     * @default 5
     */
    changeLimit: number | undefined;

    /**
     * Include suggestions with tied cost even if the number is greater than `numSuggestions`.
     * @default true
     */
    includeTies?: boolean | undefined;

    /**
     * specify if case / accents should be ignored when looking for suggestions.
     * @default true
     */
    ignoreCase: boolean | undefined;

    /**
     * the total amount of time to allow for suggestions.
     * @default 1000
     */
    timeout?: number | undefined;

    /**
     * Used to improve the sorted results.
     */
    weightMap?: WeightMap | undefined;
}

export type SuggestionCollectorOptionsRO = Readonly<SuggestionCollectorOptions>;

export const defaultSuggestionCollectorOptions: Readonly<RequireOptional<SuggestionCollectorOptions>> = Object.freeze({
    numSuggestions: defaultMaxNumberSuggestions,
    filter: () => true,
    changeLimit: MAX_NUM_CHANGES,
    includeTies: false,
    ignoreCase: true,
    timeout: DEFAULT_COLLECTOR_TIMEOUT,
    weightMap: undefined,
    compoundSeparator: '',
    compoundMethod: undefined,
});

export function suggestionCollector(wordToMatch: string, options: SuggestionCollectorOptionsRO): SuggestionCollector {
    const {
        filter = () => true,
        changeLimit = MAX_NUM_CHANGES,
        includeTies = false,
        ignoreCase = true,
        timeout = DEFAULT_COLLECTOR_TIMEOUT,
        weightMap,
        compoundSeparator = defaultSuggestionCollectorOptions.compoundSeparator,
    } = options;
    // const weightMap: WeightMap | undefined = undefined;

    const numSuggestions = Math.max(options.numSuggestions, 0) || 0;
    const numSugToHold = weightMap ? numSuggestions * 2 : numSuggestions;
    const sugs = new Map<string, SuggestionResultBase>();
    let maxCost: number = BASE_COST * Math.min(wordToMatch.length * MAX_ALLOWED_COST_SCALE, changeLimit);
    const useSeparator =
        compoundSeparator ||
        (weightMap ? DEFAULT_COMPOUNDED_WORD_SEPARATOR : defaultSuggestionCollectorOptions.compoundSeparator);

    const fnCleanWord =
        !useSeparator || useSeparator === compoundSeparator ? (w: string) => w : replaceAllFactory(useSeparator, '');

    if (useSeparator && weightMap) {
        addDefToWeightMap(weightMap, { map: useSeparator, insDel: 50 });
    }

    const genSuggestionOptions: GenSuggestionOptionsRO = clean({
        changeLimit,
        ignoreCase,
        compoundMethod: options.compoundMethod,
        compoundSeparator: useSeparator,
    });

    let timeRemaining = timeout;

    function dropMax() {
        if (sugs.size < 2 || !numSuggestions) {
            sugs.clear();
            return;
        }
        const sorted = [...sugs.values()].sort(compSuggestionResults);
        let i = numSugToHold - 1;
        maxCost = sorted[i].cost;
        for (; i < sorted.length && sorted[i].cost <= maxCost; ++i) {
            /* empty */
        }
        for (; i < sorted.length; ++i) {
            sugs.delete(sorted[i].word);
        }
    }

    function adjustCost(sug: SuggestionResultBase): SuggestionResultBase {
        if (sug.isPreferred) return sug;
        const words = sug.word.split(regexSeparator);
        const extraCost =
            words.map((w) => wordLengthCost[w.length] || 0).reduce((a, b) => a + b, 0) +
            (words.length - 1) * EXTRA_WORD_COST;
        return { word: sug.word, cost: sug.cost + extraCost };
    }

    function collectSuggestion(suggestion: SuggestionResultBase): MaxCost {
        const { word, cost, isPreferred } = adjustCost(suggestion);
        if (cost <= maxCost && filter(suggestion.word, cost)) {
            const known = sugs.get(word);
            if (known) {
                known.cost = Math.min(known.cost, cost);
                known.isPreferred = known.isPreferred || isPreferred;
            } else {
                sugs.set(word, { word, cost, isPreferred });
                if (cost < maxCost && sugs.size > numSugToHold) {
                    dropMax();
                }
            }
        }
        return maxCost;
    }

    /**
     * Collection suggestions from a SuggestionIterator
     * @param src - the SuggestionIterator used to generate suggestions.
     * @param timeout - the amount of time in milliseconds to allow for suggestions.
     */
    function collect(src: SuggestionGenerator, timeout?: number, filter?: FilterWordFn) {
        let stop: false | symbol = false;
        timeout = timeout ?? timeRemaining;
        timeout = Math.min(timeout, timeRemaining);
        if (timeout < 0) return;

        const timer = startTimer();

        let ir: IteratorResult<SuggestionResultBase | Progress | undefined>;
        while (!(ir = src.next(stop || maxCost)).done) {
            if (timer() > timeout) {
                stop = symStopProcessing;
            }
            const { value } = ir;
            if (!value) continue;
            if (isSuggestionResult(value)) {
                if (!filter || filter(value.word, value.cost)) {
                    collectSuggestion(value);
                }
                continue;
            }
        }

        timeRemaining -= timer();
    }

    function cleanCompoundResult(sr: SuggestionResultBase): SuggestionResult {
        const { word, cost } = sr;
        const cWord = fnCleanWord(word);
        if (cWord !== word) {
            return {
                word: cWord,
                cost,
                compoundWord: word,
                isPreferred: undefined,
            };
        }
        return { ...sr };
    }

    function suggestions() {
        if (numSuggestions < 1 || !sugs.size) return [];
        const NF = 'NFD';
        const nWordToMatch = wordToMatch.normalize(NF);
        const rawValues = [...sugs.values()];
        const values = weightMap
            ? rawValues.map(({ word, cost, isPreferred }) => ({
                  word,
                  cost: isPreferred ? cost : editDistanceWeighted(nWordToMatch, word.normalize(NF), weightMap, 110),
                  isPreferred,
              }))
            : rawValues;

        const sorted = values.sort(compSuggestionResults).map(cleanCompoundResult);
        let i = Math.min(sorted.length, numSuggestions) - 1;
        const limit = includeTies ? sorted.length : Math.min(sorted.length, numSuggestions);
        const iCost = sorted[i].cost;
        const maxCost = Math.min(iCost, weightMap ? changeLimit * BASE_COST - 1 : iCost);
        for (i = 1; i < limit && sorted[i].cost <= maxCost; ++i) {
            // loop
        }
        sorted.length = i;
        return sorted;
    }

    const collector: SuggestionCollector = {
        collect,
        add: function (suggestion: SuggestionResultBase) {
            collectSuggestion(suggestion);
            return this;
        },
        get suggestions() {
            return suggestions();
        },
        get maxCost() {
            return maxCost;
        },
        get word() {
            return wordToMatch;
        },
        get maxNumSuggestions() {
            return numSuggestions;
        },
        get changeLimit() {
            return changeLimit;
        },
        includesTies: includeTies,
        ignoreCase,
        symbolStopProcessing: symStopProcessing,
        genSuggestionOptions,
    };

    return collector;
}

/**
 * Impersonating a Collector, allows searching for multiple variants on the same word.
 * The collection is still in the original collector.
 * @param collector - collector to impersonate
 * @param word - word to present instead of `collector.word`.
 * @returns a SuggestionCollector
 */
export function impersonateCollector(collector: SuggestionCollector, word: string): SuggestionCollector {
    const r = Object.create(collector);
    Object.defineProperty(r, 'word', { value: word, writable: false });
    return r;
}

export function isSuggestionResult(s: GenerateSuggestionResult): s is SuggestionResult {
    const r = s as Partial<SuggestionResult> | undefined;
    return !!r && typeof r === 'object' && r?.cost !== undefined && r.word != undefined;
}
