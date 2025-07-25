import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
    isAbsolute as isAbsolutePath,
    relative as relativePath,
    resolve as resolvePath,
    sep as pathSep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { isUrlLike, toFilePathOrHref } from '@cspell/url';

import { readFileInfo } from '../../util/fileHelper.js';
import type { LintFileResult } from '../../util/LintFileResult.js';
import type { CSpellLintResultCache } from './CSpellLintResultCache.js';
import type { FileDescriptor, FileEntryCache } from './fileEntryCache.js';
import { createFromFile } from './fileEntryCache.js';
import { ShallowObjectCollection } from './ObjectCollection.js';

export type CachedFileResult = Omit<LintFileResult, 'fileInfo' | 'elapsedTimeMs' | 'cached'>;

/**
 * This is the data cached.
 * Property names are short to help keep the cache file size small.
 */
interface CachedData {
    /** meta version + suffix */
    v?: string | undefined;
    /** results */
    r?: CachedFileResult | undefined;
    /** dependencies */
    d?: Dependency[] | undefined;
}

interface Dependency {
    /** filename */
    f: string;
    /** hash of file contents */
    h?: string | undefined;
}

interface CSpellCachedMetaData {
    data?: CachedData;
}

type Meta = FileDescriptor['meta'];

export type CSpellCacheMeta = (Meta & CSpellCachedMetaData) | undefined;

type CacheDataKeys = {
    [K in keyof Required<CachedData>]: K;
};

const cacheDataKeys: CacheDataKeys = {
    v: 'v',
    r: 'r',
    d: 'd',
};

/**
 * Meta Data Version is used to detect if the structure of the meta data has changed.
 * This is used in combination with the Suffix and the version of CSpell.
 */
const META_DATA_BASE_VERSION = '1';
const META_DATA_VERSION_SUFFIX = '-' + META_DATA_BASE_VERSION + '-' + Object.keys(cacheDataKeys).join('|');

interface DependencyCacheTree {
    d?: Dependency[];
    c?: Map<string, DependencyCacheTree>;
}

/**
 * Caches cspell results on disk
 */
export class DiskCache implements CSpellLintResultCache {
    private cacheDir: string;
    private dependencyCache: Map<string, Dependency> = new Map();
    private dependencyCacheTree: DependencyCacheTree = {};
    private objectCollection = new ShallowObjectCollection<CachedData>();
    private ocCacheFileResult = new ShallowObjectCollection<CachedFileResult>();
    readonly version: string;

    constructor(
        readonly cacheFileLocation: URL,
        readonly useCheckSum: boolean,
        readonly cspellVersion: string,
        readonly useUniversalCache: boolean,
        private fileEntryCache: FileEntryCache,
    ) {
        this.cacheDir = fileURLToPath(new URL('./', cacheFileLocation));
        this.version = calcVersion(cspellVersion);
    }

    public async getCachedLintResults(filename: string): Promise<LintFileResult | undefined> {
        filename = normalizePath(filename);
        const fileDescriptor = await this.fileEntryCache.getFileDescriptor(filename);
        const meta = fileDescriptor.meta as CSpellCacheMeta;
        const data = meta?.data;
        const result = data?.r;
        const versionMatches = this.version === data?.v;

        // Cached lint results are valid if and only if:
        // 1. The file is present in the filesystem
        // 2. The file has not changed since the time it was previously linted
        // 3. The CSpell configuration has not changed since the time the file was previously linted
        // If any of these are not true, we will not reuse the lint results.
        if (
            fileDescriptor.notFound ||
            fileDescriptor.changed ||
            !meta ||
            !result ||
            !versionMatches ||
            !(await this.checkDependencies(data.d))
        ) {
            return undefined;
        }

        const dd = { ...data };

        if (dd.d) {
            dd.d = setTreeEntry(this.dependencyCacheTree, dd.d);
        }
        dd.r = dd.r && this.normalizeResult(dd.r);
        meta.data = this.objectCollection.get(dd);

        // Skip reading empty files and files without lint error
        const hasErrors = !!result && (result.errors > 0 || result.configErrors > 0 || result.issues.length > 0);
        const cached = true;
        const shouldReadFile = cached && hasErrors;

        return {
            ...result,
            elapsedTimeMs: undefined,
            fileInfo: shouldReadFile ? await readFileInfo(filename) : { filename },
            cached,
        };
    }

    public async setCachedLintResults(
        { fileInfo, elapsedTimeMs: _, cached: __, ...result }: LintFileResult,
        dependsUponFiles: string[],
    ): Promise<void> {
        const fileDescriptor = await this.fileEntryCache.getFileDescriptor(fileInfo.filename);
        const meta = fileDescriptor.meta as CSpellCacheMeta;
        if (fileDescriptor.notFound || !meta) {
            return;
        }

        const data: CachedData = this.objectCollection.get({
            v: this.version,
            r: this.normalizeResult(result),
            d: await this.calcDependencyHashes(dependsUponFiles),
        });

        meta.data = data;
    }

    public async reconcile(): Promise<void> {
        await this.fileEntryCache.reconcile();
    }

    public async reset(): Promise<void> {
        await this.fileEntryCache.destroy();
        this.dependencyCache.clear();
        this.dependencyCacheTree = {};
        this.objectCollection = new ShallowObjectCollection<CachedData>();
        this.ocCacheFileResult = new ShallowObjectCollection<CachedFileResult>();
    }

    private normalizeResult(result: CachedFileResult): CachedFileResult {
        const { issues, processed, errors, configErrors, reportIssueOptions, ...rest } = result;
        if (!Object.keys(rest).length) {
            return this.ocCacheFileResult.get(result);
        }
        return this.ocCacheFileResult.get({ issues, processed, errors, configErrors, reportIssueOptions });
    }

    private async calcDependencyHashes(dependsUponFiles: string[]): Promise<Dependency[]> {
        dependsUponFiles.sort();

        const c = getTreeEntry(this.dependencyCacheTree, dependsUponFiles);
        if (c?.d) {
            return c.d;
        }

        const dependencies: Dependency[] = await Promise.all(dependsUponFiles.map((f) => this.getDependency(f)));

        return setTreeEntry(this.dependencyCacheTree, dependencies);
    }

    private async checkDependency(dep: Dependency): Promise<boolean> {
        const depFile = this.resolveFile(dep.f);
        const cDep = this.dependencyCache.get(depFile);

        if (cDep && compDep(dep, cDep)) return true;
        if (cDep) return false;

        const d = await this.getFileDep(depFile);
        if (compDep(dep, d)) {
            this.dependencyCache.set(depFile, dep);
            return true;
        }
        this.dependencyCache.set(depFile, d);
        return false;
    }

    private async getDependency(file: string): Promise<Dependency> {
        const dep = this.dependencyCache.get(file);
        if (dep) return dep;
        const d = await this.getFileDep(file);
        this.dependencyCache.set(file, d);
        return d;
    }

    private async getFileDep(file: string): Promise<Dependency> {
        if (isUrlLike(file)) {
            if (!file.startsWith('file://')) {
                return getDependencyForUrl(file);
            }
            file = toFilePathOrHref(file);
        }
        assert(isAbsolutePath(file), `Dependency must be absolute "${file}"`);
        const f = this.toRelFile(file);
        let h: string;
        try {
            const buffer = await fs.readFile(file);
            h = this.getHash(buffer);
        } catch {
            return { f };
        }
        return { f, h };
    }

    private async checkDependencies(dependencies: Dependency[] | undefined): Promise<boolean> {
        if (!dependencies) return false;
        for (const dep of dependencies) {
            if (!(await this.checkDependency(dep))) {
                return false;
            }
        }
        return true;
    }

    private getHash(buffer: Buffer): string {
        return crypto.createHash('md5').update(buffer).digest('hex');
    }

    private resolveFile(file: string): string {
        if (isUrlLike(file)) {
            return file;
        }
        return normalizePath(resolvePath(this.cacheDir, file));
    }

    private toRelFile(file: string): string {
        return normalizePath(this.useUniversalCache ? relativePath(this.cacheDir, file) : file);
    }
}

async function getDependencyForUrl(remoteUrl: string | URL): Promise<Dependency> {
    const url = new URL(remoteUrl);

    try {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins
        const response = await fetch(url, { method: 'HEAD' });
        const h =
            response.headers.get('etag') ||
            response.headers.get('last-modified') ||
            response.headers.get('content-length') ||
            '';
        return { f: url.href, h: h ? h.trim() : '' };
    } catch {
        // If the fetch fails, we cannot compute a hash, so we return an empty hash.
        return { f: url.href, h: '' };
    }
}

export async function createDiskCache(
    cacheFileLocation: URL,
    useCheckSum: boolean,
    cspellVersion: string,
    useUniversalCache: boolean,
): Promise<DiskCache> {
    const fileEntryCache = await createFromFile(cacheFileLocation, useCheckSum, useUniversalCache);
    const cache = new DiskCache(cacheFileLocation, useCheckSum, cspellVersion, useUniversalCache, fileEntryCache);
    return cache;
}

function getTreeEntry(tree: DependencyCacheTree, keys: string[]): DependencyCacheTree | undefined {
    let r: DependencyCacheTree | undefined = tree;
    for (const k of keys) {
        r = r.c?.get(k);
        if (!r) return r;
    }
    return r;
}

function setTreeEntry(tree: DependencyCacheTree, deps: Dependency[], update = false): Dependency[] {
    let r = tree;
    for (const d of deps) {
        const k = d.f;
        if (!r.c) {
            r.c = new Map();
        }
        const cn = r.c.get(k);
        const n = cn ?? {};
        if (!cn) {
            r.c.set(k, n);
        }
        r = n;
    }
    let d = r.d;
    if (!d || (r.d && update)) {
        r.d = deps;
        d = deps;
    }
    return d;
}

function compDep(a: Dependency, b: Dependency) {
    return a.f === b.f && a.h === b.h;
}

function calcVersion(version: string): string {
    return version + META_DATA_VERSION_SUFFIX;
}

export function normalizePath(filePath: string): string {
    if (pathSep === '/') return filePath;
    return filePath.split(pathSep).join('/');
}

export const __testing__: {
    calcVersion: typeof calcVersion;
    getDependencyForUrl: typeof getDependencyForUrl;
} = {
    calcVersion,
    getDependencyForUrl,
};
