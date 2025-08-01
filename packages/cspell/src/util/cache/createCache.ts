import assert from 'node:assert';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { CacheSettings, CSpellSettings } from '@cspell/cspell-types';
import { toFileURL } from '@cspell/url';

import { isErrorLike } from '../errors.js';
import type { CacheOptions } from './CacheOptions.js';
import type { CSpellLintResultCache } from './CSpellLintResultCache.js';
import { createDiskCache } from './DiskCache.js';
import { DummyCache } from './DummyCache.js';

// cspell:word cspellcache
export const DEFAULT_CACHE_LOCATION = '.cspellcache';

export interface CreateCacheSettings extends Required<CacheSettings> {
    /**
     * cspell version used to validate cache entries.
     */
    version: string;

    /**
     * When true, causes the cache to be reset, removing any entries
     * or cache files.
     */
    reset?: true;
}

const versionSuffix = '';

/**
 * Creates CSpellLintResultCache (disk cache if caching is enabled in config or dummy otherwise)
 */
export async function createCache(options: CreateCacheSettings): Promise<CSpellLintResultCache> {
    const { useCache, cacheLocation, cacheStrategy, reset } = options;
    const location = toFileURL(cacheLocation);
    const useChecksum = cacheStrategy === 'content';
    const version = normalizeVersion(options.version);
    const useUniversal = options.cacheFormat === 'universal';
    const cache = useCache ? await createDiskCache(location, useChecksum, version, useUniversal) : new DummyCache();
    if (reset) {
        await cache.reset();
    }
    return cache;
}

export async function calcCacheSettings(
    config: CSpellSettings,
    cacheOptions: CacheOptions,
    root: string,
): Promise<CreateCacheSettings> {
    const cs = config.cache ?? {};
    const useCache = cacheOptions.cache ?? cs.useCache ?? false;
    const cacheLocation = await resolveCacheLocation(
        path.resolve(root, cacheOptions.cacheLocation ?? cs.cacheLocation ?? DEFAULT_CACHE_LOCATION),
    );

    const cacheStrategy = cacheOptions.cacheStrategy ?? cs.cacheStrategy ?? 'content';
    const cacheFormat = cacheOptions.cacheFormat ?? cs.cacheFormat ?? 'universal';
    const optionals: Partial<CreateCacheSettings> = {};
    if (cacheOptions.cacheReset) {
        optionals.reset = true;
    }
    return {
        ...optionals,
        useCache,
        cacheLocation,
        cacheStrategy,
        version: cacheOptions.version,
        cacheFormat,
    };
}

async function resolveCacheLocation(cacheLocation: string): Promise<string> {
    try {
        const s = await stat(cacheLocation);
        if (s.isFile()) return cacheLocation;
        return path.join(cacheLocation, DEFAULT_CACHE_LOCATION);
    } catch (err) {
        if (isErrorLike(err) && err.code === 'ENOENT') {
            return cacheLocation;
        }
        throw err;
    }
}

/**
 * Normalizes the version and return only `major.minor + versionSuffix`
 * @param version The cspell semantic version.
 */
function normalizeVersion(version: string): string {
    const parts = version.split('.').slice(0, 2);
    assert(parts.length === 2);
    return parts.join('.') + versionSuffix;
}

export const __testing__: {
    normalizeVersion: typeof normalizeVersion;
    versionSuffix: string;
} = {
    normalizeVersion,
    versionSuffix,
};
