import * as path from 'node:path';
import { format } from 'node:util';

import { isAsyncIterable, operators, opFilter, pipeAsync } from '@cspell/cspell-pipe';
import { opMap, pipe } from '@cspell/cspell-pipe/sync';
import type {
    CSpellSettings,
    Glob,
    Issue,
    ReportIssueOptions,
    RunResult,
    TextDocumentOffset,
} from '@cspell/cspell-types';
import { MessageTypes } from '@cspell/cspell-types';
import { toFileURL } from '@cspell/url';
import chalk from 'chalk';
import { _debug as cspellDictionaryDebug } from 'cspell-dictionary';
import { findRepoRoot, GitIgnore } from 'cspell-gitignore';
import { GlobMatcher, type GlobMatchOptions, type GlobPatternNormalized, type GlobPatternWithRoot } from 'cspell-glob';
import type { Logger, SpellCheckFileResult, ValidationIssue } from 'cspell-lib';
import {
    ENV_CSPELL_GLOB_ROOT,
    extractDependencies,
    extractImportErrors,
    getDefaultConfigLoader,
    getDictionary,
    isBinaryFile as cspellIsBinaryFile,
    mergeSettings,
    setLogger,
    shouldCheckDocument,
    spellCheckDocument,
    Text as cspellText,
} from 'cspell-lib';

import { console } from '../console.js';
import { getEnvironmentVariable, setEnvironmentVariable, truthy } from '../environment.js';
import { getFeatureFlags } from '../featureFlags/index.js';
import { CSpellReporterConfiguration } from '../models.js';
import { npmPackage } from '../pkgInfo.js';
import type { CreateCacheSettings, CSpellLintResultCache } from '../util/cache/index.js';
import { calcCacheSettings, createCache } from '../util/cache/index.js';
import { type ConfigInfo, readConfig } from '../util/configFileHelper.js';
import { CheckFailed, toApplicationError, toError } from '../util/errors.js';
import { extractContext } from '../util/extractContext.js';
import type { ReadFileInfoResult } from '../util/fileHelper.js';
import {
    fileInfoToDocument,
    filenameToUri,
    findFiles,
    isBinaryFile,
    isFile,
    isNotDir,
    readFileInfo,
    readFileListFiles,
    relativeToCwd,
    resolveFilename,
} from '../util/fileHelper.js';
import type { GlobOptions } from '../util/glob.js';
import {
    buildGlobMatcher,
    extractGlobsFromMatcher,
    extractPatterns,
    normalizeFileOrGlobsToRoot,
    normalizeGlobsToRoot,
} from '../util/glob.js';
import type { LintFileResult } from '../util/LintFileResult.js';
import { prefetchIterable } from '../util/prefetch.js';
import type { FinalizedReporter } from '../util/reporters.js';
import { extractReporterIssueOptions, LintReporter, mergeReportIssueOptions } from '../util/reporters.js';
import { getTimeMeasurer } from '../util/timer.js';
import * as util from '../util/util.js';
import { writeFileOrStream } from '../util/writeFile.js';
import type { LintRequest } from './LintRequest.js';

const version = npmPackage.version;

const BATCH_SIZE = 8;

const debugStats = false;

const { opFilterAsync } = operators;

export async function runLint(cfg: LintRequest): Promise<RunResult> {
    const reporter = new LintReporter(cfg.reporter, cfg.options);
    const configErrors = new Set<string>();

    const timer = getTimeMeasurer();

    const logDictRequests = truthy(getEnvironmentVariable('CSPELL_ENABLE_DICTIONARY_LOGGING'));
    if (logDictRequests) {
        cspellDictionaryDebug.cacheDictionaryEnableLogging(true);
    }

    const lintResult = await run();

    if (logDictRequests) {
        await writeDictionaryLog();
    }

    await reporter.result(lintResult);
    const elapsed = timer();
    if (getFeatureFlags().getFlag('timer')) {
        console.log(`Elapsed Time: ${elapsed.toFixed(2)}ms`);
    }
    return lintResult;

    interface PrefetchResult {
        fileResult?: LintFileResult | undefined;
        fileInfo?: ReadFileInfoResult | undefined;
        skip?: boolean | undefined;
        reportIssueOptions?: ReportIssueOptions | undefined;
    }

    interface PFCached extends PrefetchResult {
        fileResult: LintFileResult;
        fileInfo?: undefined;
        skip?: undefined;
    }

    interface PFFile extends PrefetchResult {
        fileResult?: undefined;
        fileInfo: ReadFileInfoResult;
        skip?: undefined;
        reportIssueOptions: ReportIssueOptions | undefined;
    }

    interface PFSkipped extends PrefetchResult {
        fileResult?: undefined;
        fileInfo?: undefined;
        skip: true;
        reportIssueOptions?: undefined;
    }

    interface PrefetchFileResult {
        filename: string;
        result?: Promise<PFCached | PFFile | PFSkipped>;
    }

    function prefetch(filename: string, configInfo: ConfigInfo, cache: CSpellLintResultCache): PrefetchFileResult {
        if (isBinaryFile(filename, cfg.root)) return { filename, result: Promise.resolve({ skip: true }) };

        const reportIssueOptions = extractReporterIssueOptions(configInfo.config);

        async function fetch() {
            const getElapsedTimeMs = getTimeMeasurer();
            const cachedResult = await cache.getCachedLintResults(filename);
            if (cachedResult) {
                reporter.debug(`Filename: ${filename}, using cache`);
                const fileResult = { ...cachedResult, elapsedTimeMs: getElapsedTimeMs() };
                return { fileResult };
            }
            const uri = filenameToUri(filename, cfg.root).href;
            const checkResult = await shouldCheckDocument({ uri }, {}, configInfo.config);
            if (!checkResult.shouldCheck) return { skip: true } as const;
            const fileInfo = await readFileInfo(filename, undefined, true);
            return { fileInfo, reportIssueOptions };
        }

        const result: Promise<PFCached | PFFile | PFSkipped> = fetch();
        return { filename, result };
    }

    async function processFile(
        filename: string,
        configInfo: ConfigInfo,
        cache: CSpellLintResultCache,
        prefetch: PrefetchResult | undefined,
    ): Promise<LintFileResult> {
        if (prefetch?.fileResult) return prefetch.fileResult;

        const getElapsedTimeMs = getTimeMeasurer();
        const reportIssueOptions = prefetch?.reportIssueOptions;
        const cachedResult = await cache.getCachedLintResults(filename);
        if (cachedResult) {
            reporter.debug(`Filename: ${filename}, using cache`);
            return {
                ...cachedResult,
                elapsedTimeMs: getElapsedTimeMs(),
                reportIssueOptions: { ...cachedResult.reportIssueOptions, ...reportIssueOptions },
            };
        }

        const result: LintFileResult = {
            fileInfo: {
                filename,
            },
            issues: [],
            processed: false,
            errors: 0,
            configErrors: 0,
            elapsedTimeMs: 0,
            reportIssueOptions,
        };

        const fileInfo = prefetch?.fileInfo || (await readFileInfo(filename, undefined, true));
        if (fileInfo.errorCode) {
            if (fileInfo.errorCode !== 'EISDIR' && cfg.options.mustFindFiles) {
                const err = new LinterError(`File not found: "${filename}"`);
                reporter.error('Linter:', err);
                result.errors += 1;
            }
            return result;
        }

        const doc = fileInfoToDocument(fileInfo, cfg.options.languageId, cfg.locale);
        const { text } = fileInfo;
        result.fileInfo = fileInfo;

        let spellResult: Partial<SpellCheckFileResult> = {};
        reporter.info(
            `Checking: ${filename}, File type: ${doc.languageId ?? 'auto'}, Language: ${doc.locale ?? 'default'}`,
            MessageTypes.Info,
        );
        try {
            const { showSuggestions: generateSuggestions, validateDirectives, skipValidation } = cfg.options;
            const numSuggestions = configInfo.config.numSuggestions ?? 5;
            const validateOptions = util.clean({
                generateSuggestions,
                numSuggestions,
                validateDirectives,
                skipValidation,
            });
            const r = await spellCheckDocument(doc, validateOptions, configInfo.config);
            // console.warn('filename: %o %o', path.relative(process.cwd(), filename), r.perf);
            spellResult = r;
            result.processed = r.checked;
            result.perf = r.perf ? { ...r.perf } : undefined;
            result.issues = cspellText.calculateTextDocumentOffsets(doc.uri, text, r.issues).map(mapIssue);
        } catch (e) {
            reporter.error(`Failed to process "${filename}"`, toError(e));
            result.errors += 1;
        }
        result.elapsedTimeMs = getElapsedTimeMs();

        const config = spellResult.settingsUsed ?? {};
        result.reportIssueOptions = mergeReportIssueOptions(
            spellResult.settingsUsed || configInfo.config,
            reportIssueOptions,
        );
        result.configErrors += await reportConfigurationErrors(config);

        const elapsed = result.elapsedTimeMs;
        const dictionaries = config.dictionaries || [];
        reporter.info(
            `Checked: ${filename}, File type: ${config.languageId}, Language: ${config.language} ... Issues: ${
                result.issues.length
            } ${elapsed.toFixed(2)}ms`,
            MessageTypes.Info,
        );
        reporter.info(`Config file Used: ${spellResult.localConfigFilepath || configInfo.source}`, MessageTypes.Info);
        reporter.info(`Dictionaries Used: ${dictionaries.join(', ')}`, MessageTypes.Info);

        if (cfg.options.debug) {
            const { id: _id, name: _name, __imports, __importRef, ...cfg } = config;
            const debugCfg = {
                filename,
                languageId: doc.languageId ?? cfg.languageId ?? 'default',
                // eslint-disable-next-line unicorn/no-null
                config: { ...cfg, source: null },
                source: spellResult.localConfigFilepath,
            };
            reporter.debug(JSON.stringify(debugCfg, undefined, 2));
        }

        const dep = calcDependencies(config);

        await cache.setCachedLintResults(result, dep.files);
        return result;
    }

    function mapIssue({ doc: _, ...tdo }: TextDocumentOffset & ValidationIssue): Issue {
        const context = cfg.showContext ? extractContext(tdo, cfg.showContext) : undefined;
        return util.clean({ ...tdo, context });
    }

    async function processFiles(
        files: string[] | AsyncIterable<string>,
        configInfo: ConfigInfo,
        cacheSettings: CreateCacheSettings,
    ): Promise<RunResult> {
        const fileCount = Array.isArray(files) ? files.length : undefined;
        const status: RunResult = runResult();
        const cache = await createCache(cacheSettings);
        const failFast = cfg.options.failFast ?? configInfo.config.failFast ?? false;

        function* prefetchFiles(files: string[]) {
            const iter = prefetchIterable(
                pipe(
                    files,
                    opMap((filename) => prefetch(filename, configInfo, cache)),
                ),
                BATCH_SIZE,
            );
            for (const v of iter) {
                yield v;
            }
        }

        async function* prefetchFilesAsync(files: string[] | AsyncIterable<string>) {
            for await (const filename of files) {
                yield prefetch(filename, configInfo, cache);
            }
        }

        const emptyResult: LintFileResult = {
            fileInfo: { filename: '' },
            issues: [],
            processed: false,
            errors: 0,
            configErrors: 0,
            elapsedTimeMs: 1,
            reportIssueOptions: undefined,
        };

        async function processPrefetchFileResult(pf: PrefetchFileResult, index: number) {
            const { filename, result: pFetchResult } = pf;
            const getElapsedTimeMs = getTimeMeasurer();
            const fetchResult = await pFetchResult;
            reporter.emitProgressBegin(filename, index, fileCount ?? index);
            if (fetchResult?.skip) {
                return {
                    filename,
                    fileNum: index,
                    result: { ...emptyResult, fileInfo: { filename }, elapsedTimeMs: getElapsedTimeMs() },
                };
            }
            const result = await processFile(filename, configInfo, cache, fetchResult);
            return { filename, fileNum: index, result };
        }

        async function* loadAndProcessFiles() {
            let i = 0;
            if (isAsyncIterable(files)) {
                for await (const pf of prefetchFilesAsync(files)) {
                    yield processPrefetchFileResult(pf, ++i);
                }
            } else {
                for (const pf of prefetchFiles(files)) {
                    await pf.result;
                    yield processPrefetchFileResult(pf, ++i);
                }
                // const iter = prefetchIterable(
                //     pipe(
                //         prefetchFiles(files),
                //         opMap(async (pf) => {
                //             return processPrefetchFileResult(pf, ++i);
                //         }),
                //     ),
                //     BATCH_SIZE,
                // );

                // yield* iter;
            }
        }

        for await (const fileP of loadAndProcessFiles()) {
            const { filename, fileNum, result } = fileP;
            status.files += 1;
            status.cachedFiles = (status.cachedFiles || 0) + (result.cached ? 1 : 0);
            const numIssues = reporter.emitProgressComplete(filename, fileNum, fileCount ?? fileNum, result);
            if (numIssues || result.errors) {
                status.filesWithIssues.add(relativeToCwd(filename, cfg.root));
                status.issues += numIssues;
                status.errors += result.errors;
                if (failFast) {
                    return status;
                }
            }
            status.errors += result.configErrors;
        }

        await cache.reconcile();
        return status;
    }

    interface ConfigDependencies {
        files: string[];
    }

    function calcDependencies(config: CSpellSettings): ConfigDependencies {
        const { configFiles, dictionaryFiles } = extractDependencies(config);

        return { files: [...configFiles, ...dictionaryFiles] };
    }

    async function reportConfigurationErrors(config: CSpellSettings): Promise<number> {
        const errors = extractImportErrors(config);
        let count = 0;
        errors.forEach((ref) => {
            const key = ref.error.toString();
            if (configErrors.has(key)) return;
            configErrors.add(key);
            count += 1;
            reporter.error('Configuration', ref.error);
        });

        const dictCollection = await getDictionary(config);
        dictCollection.dictionaries.forEach((dict) => {
            const dictErrors = dict.getErrors?.() || [];
            const msg = `Dictionary Error with (${dict.name})`;
            dictErrors.forEach((error) => {
                const key = msg + error.toString();
                if (configErrors.has(key)) return;
                configErrors.add(key);
                count += 1;
                reporter.error(msg, error);
            });
        });

        return count;
    }

    function countConfigErrors(configInfo: ConfigInfo): Promise<number> {
        return reportConfigurationErrors(configInfo.config);
    }

    async function run(): Promise<RunResult> {
        if (cfg.options.root) {
            setEnvironmentVariable(ENV_CSPELL_GLOB_ROOT, cfg.root);
        }

        const configInfo: ConfigInfo = await readConfig(cfg.configFile, cfg.root, cfg.options.stopConfigSearchAt);
        if (cfg.options.defaultConfiguration !== undefined) {
            configInfo.config.loadDefaultConfiguration = cfg.options.defaultConfiguration;
        }
        configInfo.config = mergeSettings(configInfo.config, cfg.cspellSettingsFromCliOptions);
        const reporterConfig: CSpellReporterConfiguration = util.clean({
            maxNumberOfProblems: configInfo.config.maxNumberOfProblems,
            maxDuplicateProblems: configInfo.config.maxDuplicateProblems,
            minWordLength: configInfo.config.minWordLength,
            ...cfg.options,
            console,
        });

        const reporters = cfg.options.reporter ?? configInfo.config.reporters;
        reporter.config = reporterConfig;
        await reporter.loadReportersAndFinalize(reporters);
        setLogger(getLoggerFromReporter(reporter));

        const globInfo = await determineGlobs(configInfo, cfg);
        const { fileGlobs, excludeGlobs } = globInfo;
        const hasFileLists = !!cfg.fileLists.length;
        if (!fileGlobs.length && !hasFileLists && !cfg.files?.length) {
            // Nothing to do.
            return runResult();
        }
        header(fileGlobs, excludeGlobs);

        checkGlobs(fileGlobs, reporter);

        reporter.info(`Config Files Found:\n    ${configInfo.source}\n`, MessageTypes.Info);

        const configErrors = await countConfigErrors(configInfo);
        if (configErrors && cfg.options.exitCode !== false && !cfg.options.continueOnError) {
            return runResult({ errors: configErrors });
        }

        // Get Exclusions from the config files.
        const { root } = cfg;

        try {
            const cacheSettings = await calcCacheSettings(configInfo.config, { ...cfg.options, version }, root);
            const files = await determineFilesToCheck(configInfo, cfg, reporter, globInfo);

            const result = await processFiles(files, configInfo, cacheSettings);
            if (configErrors && cfg.options.exitCode !== false) {
                result.errors ||= configErrors;
            }
            debugStats && console.error('stats: %o', getDefaultConfigLoader().getStats());
            return result;
        } catch (e) {
            const err = toApplicationError(e);
            reporter.error('Linter', err);
            return runResult({ errors: 1 });
        }
    }

    function header(files: string[], cliExcludes: string[]) {
        const formattedFiles = files.length > 100 ? [...files.slice(0, 100), '...'] : files;

        reporter.info(
            `
cspell;
Date: ${new Date().toUTCString()}
Options:
    verbose:   ${yesNo(!!cfg.options.verbose)}
    config:    ${cfg.configFile || 'default'}
    exclude:   ${cliExcludes.join('\n               ')}
    files:     ${formattedFiles}
    wordsOnly: ${yesNo(!!cfg.options.wordsOnly)}
    unique:    ${yesNo(!!cfg.options.unique)}
`,
            MessageTypes.Info,
        );
    }
}

interface AppGlobInfo {
    /** globs from cli or config.files */
    allGlobs: Glob[];
    /** GitIgnore config to use. */
    gitIgnore: GitIgnore | undefined;
    /** file globs used to search for matching files. */
    fileGlobs: string[];
    /** globs to exclude files found. */
    excludeGlobs: string[];
    /** normalized cli exclude globs */
    normalizedExcludes: string[];
}

function checkGlobs(globs: string[], reporter: FinalizedReporter) {
    globs
        .filter((g) => g.startsWith("'") || g.endsWith("'"))
        .map((glob) => chalk.yellow(glob))
        .forEach((glob) =>
            reporter.error(
                'Linter',
                new CheckFailed(
                    `Glob starting or ending with ' (single quote) is not likely to match any files: ${glob}.`,
                ),
            ),
        );
}

async function determineGlobs(configInfo: ConfigInfo, cfg: LintRequest): Promise<AppGlobInfo> {
    const useGitignore = cfg.options.gitignore ?? configInfo.config.useGitignore ?? false;
    const gitignoreRoots = cfg.options.gitignoreRoot ?? configInfo.config.gitignoreRoot;
    const gitIgnore = useGitignore ? await generateGitIgnore(gitignoreRoots) : undefined;

    const cliGlobs: string[] = cfg.fileGlobs;
    const allGlobs: Glob[] =
        (cliGlobs.length && cliGlobs) || (cfg.options.filterFiles !== false && configInfo.config.files) || [];
    const combinedGlobs = await normalizeFileOrGlobsToRoot(allGlobs, cfg.root);
    const cliExcludeGlobs = extractPatterns(cfg.excludes).map((p) => p.glob as Glob);
    const normalizedExcludes = normalizeGlobsToRoot(cliExcludeGlobs, cfg.root, true);
    const includeGlobs = combinedGlobs.filter((g) => !g.startsWith('!'));
    const excludeGlobs = [
        ...combinedGlobs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)),
        ...normalizedExcludes,
    ];
    const fileGlobs: string[] = includeGlobs;

    const appGlobs = { allGlobs, gitIgnore, fileGlobs, excludeGlobs, normalizedExcludes };
    return appGlobs;
}

async function determineFilesToCheck(
    configInfo: ConfigInfo,
    cfg: LintRequest,
    reporter: FinalizedReporter,
    globInfo: AppGlobInfo,
): Promise<string[] | AsyncIterable<string>> {
    async function _determineFilesToCheck(): Promise<string[] | AsyncIterable<string>> {
        const { fileLists } = cfg;
        const hasFileLists = !!fileLists.length;
        const { allGlobs, gitIgnore, fileGlobs, excludeGlobs, normalizedExcludes } = globInfo;

        // Get Exclusions from the config files.
        const { root } = cfg;
        const globsToExcludeRaw = [...(configInfo.config.ignorePaths || []), ...excludeGlobs];
        const globsToExclude = globsToExcludeRaw.filter((g) => !globPattern(g).startsWith('!'));
        if (globsToExclude.length !== globsToExcludeRaw.length) {
            const globs = globsToExcludeRaw.map((g) => globPattern(g)).filter((g) => g.startsWith('!'));
            const msg = `Negative glob exclusions are not supported: ${globs.join(', ')}`;
            reporter.info(msg, MessageTypes.Warning);
        }
        const globMatcher = buildGlobMatcher(globsToExclude, root, true);
        const ignoreGlobs = extractGlobsFromMatcher(globMatcher);
        // cspell:word nodir
        const globOptions: GlobOptions = {
            root,
            cwd: root,
            ignore: [...ignoreGlobs, ...normalizedExcludes],
            nodir: true,
        };
        const enableGlobDot = cfg.enableGlobDot ?? configInfo.config.enableGlobDot;
        if (enableGlobDot !== undefined) {
            globOptions.dot = enableGlobDot;
        }

        const opFilterExcludedFiles = opFilter(filterOutExcludedFilesFn(globMatcher));
        const includeFilter = createIncludeFileFilterFn(allGlobs, root, enableGlobDot);
        const rawCliFiles = cfg.files?.map((file) => resolveFilename(file, root)).filter(includeFilter);
        const cliFiles = cfg.options.mustFindFiles
            ? rawCliFiles
            : rawCliFiles && pipeAsync(rawCliFiles, opFilterAsync(isFile));
        const foundFiles = hasFileLists
            ? concatAsyncIterables(cliFiles, await useFileLists(fileLists, includeFilter))
            : cliFiles || (await findFiles(fileGlobs, globOptions));
        const filtered = gitIgnore ? await gitIgnore.filterOutIgnored(foundFiles) : foundFiles;
        const files = isAsyncIterable(filtered)
            ? pipeAsync(filtered, opFilterExcludedFiles)
            : [...pipe(filtered, opFilterExcludedFiles)];
        return files;
    }

    function isExcluded(filename: string, globMatcherExclude: GlobMatcher) {
        if (cspellIsBinaryFile(toFileURL(filename))) {
            return true;
        }
        const { root } = cfg;
        const absFilename = path.resolve(root, filename);
        const r = globMatcherExclude.matchEx(absFilename);

        if (r.matched) {
            const { glob, source } = extractGlobSource(r.pattern);
            reporter.info(
                `Excluded File: ${path.relative(root, absFilename)}; Excluded by ${glob} from ${source}`,
                MessageTypes.Info,
            );
        }

        return r.matched;
    }

    function filterOutExcludedFilesFn(globMatcherExclude: GlobMatcher): (file: string) => boolean {
        const patterns = globMatcherExclude.patterns;
        const excludeInfo = patterns
            .map(extractGlobSource)
            .map(({ glob, source }) => `Glob: ${glob} from ${source}`)
            .filter(util.uniqueFn());
        reporter.info(`Exclusion Globs: \n    ${excludeInfo.join('\n    ')}\n`, MessageTypes.Info);
        return (filename: string): boolean => !isExcluded(filename, globMatcherExclude);
    }

    return _determineFilesToCheck();
}

function extractGlobSource(g: GlobPatternWithRoot | GlobPatternNormalized) {
    const { glob, rawGlob, source } = <GlobPatternNormalized>g;
    return {
        glob: rawGlob || glob,
        source,
    };
}

function runResult(init: Partial<RunResult> = {}): RunResult {
    const { files = 0, filesWithIssues = new Set<string>(), issues = 0, errors = 0, cachedFiles = 0 } = init;
    return { files, filesWithIssues, issues, errors, cachedFiles };
}

function yesNo(value: boolean) {
    return value ? 'Yes' : 'No';
}

function getLoggerFromReporter(reporter: Pick<FinalizedReporter, 'info' | 'error'>): Logger {
    const log: Logger['log'] = (...params) => {
        const msg = format(...params);
        reporter.info(msg, 'Info');
    };

    const error: Logger['error'] = (...params) => {
        const msg = format(...params);
        const err = { message: '', name: 'error', toString: () => '' };
        reporter.error(msg, err);
    };
    const warn: Logger['warn'] = (...params) => {
        const msg = format(...params);
        reporter.info(msg, 'Warning');
    };

    return {
        log,
        warn,
        error,
    };
}

async function generateGitIgnore(roots: string | string[] | undefined) {
    const root = (typeof roots === 'string' ? [roots].filter((r) => !!r) : roots) || [];
    if (!root?.length) {
        const cwd = process.cwd();
        const repo = (await findRepoRoot(cwd)) || cwd;
        root.push(repo);
    }
    return new GitIgnore(root?.map((p) => path.resolve(p)));
}

async function useFileLists(
    fileListFiles: string[],
    filterFiles: (file: string) => boolean,
): Promise<string[] | AsyncIterable<string>> {
    const files = readFileListFiles(fileListFiles);
    return pipeAsync(files, opFilter(filterFiles), opFilterAsync(isNotDir));
}

function createIncludeFileFilterFn(includeGlobPatterns: Glob[] | undefined, root: string, dot: boolean | undefined) {
    if (!includeGlobPatterns?.length) {
        return () => true;
    }
    const patterns = includeGlobPatterns.map((g) => (g === '.' ? '/**' : g));
    const options: GlobMatchOptions = { root, mode: 'include' };
    if (dot !== undefined) {
        options.dot = dot;
    }
    const globMatcher = new GlobMatcher(patterns, options);

    return (file: string) => globMatcher.match(file);
}

async function* concatAsyncIterables<T>(
    ...iterables: (AsyncIterable<T> | Iterable<T> | undefined)[]
): AsyncIterable<T> {
    for (const iter of iterables) {
        if (!iter) continue;
        yield* iter;
    }
}

async function writeDictionaryLog() {
    const fieldsCsv = getEnvironmentVariable('CSPELL_ENABLE_DICTIONARY_LOG_FIELDS') || 'time, word, value';
    const fields = fieldsCsv.split(',').map((f) => f.trim());
    const header = fields.join(', ') + '\n';
    const lines = cspellDictionaryDebug
        .cacheDictionaryGetLog()
        .filter((d) => d.method === 'has')
        .map((d) => fields.map((f) => (f in d ? `${d[f as keyof typeof d]}` : '')).join(', '));
    const data = header + lines.join('\n') + '\n';
    const filename = getEnvironmentVariable('CSPELL_ENABLE_DICTIONARY_LOG_FILE') || 'cspell-dictionary-log.csv';

    await writeFileOrStream(filename, data);
}

function globPattern(g: Glob) {
    return typeof g === 'string' ? g : g.glob;
}

export class LinterError extends Error {
    constructor(message: string) {
        super(message);
    }

    toString(): string {
        return this.message;
    }
}
