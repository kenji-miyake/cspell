// cspell:ignore ings ning gimuy anrvtbf gimuxy

export const regExUpperSOrIng: RegExp = /([\p{Lu}\p{M}]+(?:\\?['’])?(?:s|ing|ies|es|ings|ed|ning))(?!\p{Ll})/gu;
export const regExSplitWords: RegExp = /(\p{Ll}\p{M}?)(\p{Lu})/gu;
export const regExSplitWords2: RegExp = /(\p{Lu}\p{M}?)((\p{Lu}\p{M}?)\p{Ll})/gu;
export const regExpCamelCaseWordBreaksWithEnglishSuffix: RegExp =
    /(?<=\p{Ll}\p{M}?)(?=\p{Lu})|(?<=\p{Lu}\p{M}?)(?=\p{Lu}\p{M}?\p{Ll})(?!\p{Lu}\p{M}?(?:s|ing|ies|es|ings|ed|ning)(?!\p{Ll}))/gu;
export const regExpCamelCaseWordBreaks: RegExp =
    /(?<=\p{Ll}\p{M}?)(?=\p{Lu})|(?<=\p{Lu}\p{M}?)(?=\p{Lu}\p{M}?\p{Ll})/gu;
export const regExpAllPossibleWordBreaks: RegExp =
    /(?<=\p{Ll}\p{M}?)(?=\p{Lu})|(?<=\p{Lu}\p{M}?)(?=\p{Lu}\p{M}?\p{Ll})|(?<=\p{Lu}\p{M}?\p{Lu}\p{M}?)(?=\p{Ll})|(?<=\p{L}\p{M}?)(?=\P{L})|(?<=\P{L})(?=\p{L})/gu;
export const regExWords: RegExp = /\p{L}\p{M}?(?:(?:\\?['’])?\p{L}\p{M}?)*/gu;
// Words can be made of letters, numbers, period, underscore, dash, plus, and single quote
export const regExWordsAndDigits: RegExp = /[\p{L}\w'’`.+-](?:(?:\\(?=[']))?[\p{L}\p{M}\w'’`.+-])*/gu;
export const regExIgnoreCharacters: RegExp = /[\p{sc=Hiragana}\p{sc=Han}\p{sc=Katakana}\u30A0-\u30FF\p{sc=Hangul}]/gu;
export const regExFirstUpper: RegExp = /^\p{Lu}\p{M}?\p{Ll}+$/u;
export const regExAllUpper: RegExp = /^(?:\p{Lu}\p{M}?)+$/u;
export const regExAllLower: RegExp = /^(?:\p{Ll}\p{M}?)+$/u;
export const regExPossibleWordBreaks: RegExp = /[-+_’'`.\s]/g;
export const regExMatchRegExParts: RegExp = /^\s*\/([\s\S]*?)\/([gimuxy]*)\s*$/;
export const regExAccents: RegExp = /\p{M}/gu;
export const regExEscapeCharacters: RegExp = /(?<=\\)[anrvtbf]/gi;
/** Matches against leading `'` or `{single letter}'` */
export const regExDanglingQuote: RegExp = /(?<=(?:^|(?!\p{M})\P{L})(?:\p{L}\p{M}?)?)[']/gu;
/** Match tailing endings after CAPS words */
export const regExTrailingEndings: RegExp =
    /(?<=(?:\p{Lu}\p{M}?){2})['’]?(?:s|d|ings?|ies|e[ds]?|ning|th|nth)(?!\p{Ll})/gu;
export const regExNumericLiteral: RegExp = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

export function stringToRegExp(pattern: string | RegExp, defaultFlags = 'gimu', forceFlags = 'g'): RegExp | undefined {
    if (pattern instanceof RegExp) {
        return pattern;
    }
    try {
        const [, pat, flag] = [
            ...(pattern.match(regExMatchRegExParts) || ['', pattern.trim(), defaultFlags]),
            forceFlags,
        ];
        if (pat) {
            const regPattern = flag.includes('x') ? removeVerboseFromRegExp(pat) : pat;
            // Make sure the flags are unique.
            const flags = [...new Set(forceFlags + flag)].join('').replaceAll(/[^gimuy]/g, '');
            const regex = new RegExp(regPattern, flags);
            return regex;
        }
    } catch {
        /* empty */
    }
    return undefined;
}

interface ReduceResults {
    /** current offset into the pattern */
    idx: number;
    /** the cleaned RegExp */
    result: string;
}

type Reducer = (acc: ReduceResults) => ReduceResults | undefined;

const SPACES: Record<string, true | undefined> = {
    ' ': true,
    '\n': true,
    '\r': true,
    '\t': true,
};

/**
 * Remove all whitespace and comments from a regexp string. The format follows Pythons Verbose.
 * Note: this is a best attempt. Special cases for comments: `#` and spaces should be proceeded with a `\`
 *
 * All space must be proceeded by a `\` or in a character class `[]`
 *
 * @param pattern - the pattern to clean
 */
function removeVerboseFromRegExp(pattern: string): string {
    function escape(acc: ReduceResults) {
        const char = pattern[acc.idx];
        if (char !== '\\') return undefined;
        const next = pattern[++acc.idx];
        acc.idx++;
        if (next === '#') {
            acc.result += '#';
            return acc;
        }
        if (!(next in SPACES)) {
            acc.result += '\\' + next;
            return acc;
        }
        acc.result += next;
        if (next === '\r' && pattern[acc.idx] === '\n') {
            acc.result += '\n';
            acc.idx++;
        }
        return acc;
    }

    function braces(acc: ReduceResults) {
        const char = pattern[acc.idx];
        if (char !== '[') return undefined;
        acc.result += char;
        acc.idx++;
        let escCount = 0;
        while (acc.idx < pattern.length) {
            const char = pattern[acc.idx];
            acc.result += char;
            acc.idx++;
            if (char === ']' && !(escCount & 1)) break;
            escCount = char === '\\' ? escCount + 1 : 0;
        }
        return acc;
    }

    function spaces(acc: ReduceResults) {
        const char = pattern[acc.idx];
        if (!(char in SPACES)) return undefined;
        acc.idx++;
        return acc;
    }

    function comments(acc: ReduceResults) {
        const char = pattern[acc.idx];
        if (char !== '#') return undefined;
        while (acc.idx < pattern.length && pattern[acc.idx] !== '\n') {
            acc.idx++;
        }
        return acc;
    }

    function copy(acc: ReduceResults) {
        const char = pattern[acc.idx++];
        acc.result += char;
        return acc;
    }

    const reducers: Reducer[] = [escape, braces, spaces, comments, copy];

    const result: ReduceResults = { idx: 0, result: '' };

    while (result.idx < pattern.length) {
        for (const r of reducers) {
            if (r(result)) break;
        }
    }

    return result.result;
}
