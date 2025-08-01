import type { RemoveUndefined } from './types.js';

// alias for uniqueFilterFnGenerator
export const uniqueFn: typeof uniqueFilterFnGenerator = uniqueFilterFnGenerator;

type FilterFn<T> = (_v: T) => boolean;

export function uniqueFilterFnGenerator<T>(): FilterFn<T>;
export function uniqueFilterFnGenerator<T, U>(extractFn: (v: T) => U): FilterFn<T>;
export function uniqueFilterFnGenerator<T>(extractFn?: (v: T) => T): FilterFn<T> {
    const values = new Set<T>();
    const extractor = extractFn || ((a) => a);
    return (v: T) => {
        const vv = extractor(v);
        const ret = !values.has(vv);
        values.add(vv);
        return ret;
    };
}

export function unique<T>(src: T[]): T[] {
    return [...new Set(src)];
}

/**
 * Removed all properties with a value of `undefined` from the object.
 * @param src - the object to clean.
 * @returns the same object with all properties with a value of `undefined` removed.
 */
export function clean<T extends object>(src: T): RemoveUndefined<T> {
    const r = src;
    type keyOfT = keyof T;
    type keysOfT = keyOfT[];
    for (const key of Object.keys(r) as keysOfT) {
        if (r[key] === undefined) {
            delete r[key];
        }
    }
    return r as RemoveUndefined<T>;
}
