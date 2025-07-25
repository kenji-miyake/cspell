import * as path from 'node:path';
import streamConsumers from 'node:stream/consumers';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { toFileURL } from '@cspell/url';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { pathPackageRoot } from '../test/test.helper.js';
import { asyncIterableToArray } from './async.js';
import { IOError } from './errors.js';
import {
    isDir,
    isFile,
    isNotDir,
    readFileInfo,
    readFileListFile,
    readFileListFiles,
    resolveFilename,
    resolveFilenameToUrl,
} from './fileHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

vi.mock('node:stream/consumers', () => ({ default: { text: vi.fn() } }));

const packageRoot = pathPackageRoot;
const fixtures = path.join(packageRoot, 'fixtures/fileHelper');
const fileListFile = path.join(fixtures, 'file-list.txt');
const fileListFile2 = path.join(fixtures, 'nested/file-list-2.txt');

const oc = (...params: Parameters<typeof expect.objectContaining>) => expect.objectContaining(...params);
const r = path.resolve;

describe('fileHelper', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    test('readFileListFile', async () => {
        try {
            const files = ['a', 'b', 'c'];
            const mockStreamConsumersText = vi.mocked(streamConsumers.text);
            mockStreamConsumersText.mockImplementation(async () => files.join('\n'));
            const pResult = readFileListFile('stdin');
            const r = await pResult;
            expect(r).toEqual(files.map((f) => path.resolve(f)));
        } finally {
            process.stdin.isTTY = true;
        }
    });

    test('readFileListFiles', async () => {
        const files = ['file1', '../file2', 'dir/file3', 'nested/file2.txt'];
        const r = await asyncIterableToArray(readFileListFiles([fileListFile, fileListFile2]));
        expect(r).toEqual(files.map((f) => path.resolve(fixtures, f)));
    });

    test('readFileListFiles Error', () => {
        const r = asyncIterableToArray(readFileListFiles(['not-found.txt']));
        return expect(r).rejects.toEqual(oc({ message: 'Error reading file list from: "not-found.txt"' }));
    });

    test.each`
        filename                                                | handleNotFound | expected
        ${__dirname}                                            | ${true}        | ${{ filename: __dirname, text: '', errorCode: 'EISDIR' }}
        ${'not_found'}                                          | ${true}        | ${{ filename: r(__dirname, 'not_found'), text: '', errorCode: 'ENOENT' }}
        ${__filename}                                           | ${true}        | ${oc({ filename: __filename, text: expect.stringMatching(/.+\n/) })}
        ${__filename}                                           | ${false}       | ${oc({ filename: __filename, text: expect.stringMatching(/.+\n/) })}
        ${'file://' + path.relative(process.cwd(), __filename)} | ${false}       | ${oc({ filename: __filename, text: expect.stringMatching(/this bit of text/) })}
    `('readFile handle $filename $handleNotFound', async ({ filename, handleNotFound, expected }) => {
        filename = filename.startsWith('file:') ? filename : path.relative(process.cwd(), r(__dirname, filename));
        await expect(readFileInfo(filename, undefined, handleNotFound)).resolves.toEqual(expected);
    });

    test.each`
        filename       | expected
        ${__dirname}   | ${IOError}
        ${'not_found'} | ${IOError}
    `('readFile errors $filename', async ({ filename, expected }) => {
        filename = r(__dirname, filename);
        await expect(readFileInfo(filename, undefined, false)).rejects.toThrow(expected);
    });

    test.each`
        filename       | expected
        ${__filename}  | ${true}
        ${__dirname}   | ${false}
        ${'not_found'} | ${false}
    `('isFile $filename', async ({ filename, expected }) => {
        filename = r(__dirname, filename);
        expect(await isFile(filename)).toBe(expected);
    });

    test.each`
        filename       | expected
        ${__filename}  | ${false}
        ${__dirname}   | ${true}
        ${'not_found'} | ${false}
    `('isDir $filename', async ({ filename, expected }) => {
        filename = r(__dirname, filename);
        expect(await isDir(filename)).toBe(expected);
    });

    test.each`
        filename       | expected
        ${__filename}  | ${true}
        ${__dirname}   | ${false}
        ${'not_found'} | ${true}
    `('isDir $filename', async ({ filename, expected }) => {
        filename = r(__dirname, filename);
        expect(await isNotDir(filename)).toBe(expected);
    });

    test.each`
        filename               | cwd          | expected
        ${__filename}          | ${undefined} | ${__filename}
        ${__dirname}           | ${undefined} | ${__dirname}
        ${'not_found'}         | ${__dirname} | ${path.join(__dirname, 'not_found')}
        ${'not_found'}         | ${undefined} | ${path.resolve('not_found')}
        ${'stdin'}             | ${undefined} | ${'stdin://'}
        ${'file://file.txt'}   | ${undefined} | ${path.resolve('file.txt')}
        ${'stdin://source.ts'} | ${undefined} | ${pathToFileURL('source.ts').href.replace(/^file:/, 'stdin:')}
    `('resolveFilename $filename $cwd', async ({ filename, cwd, expected }) => {
        expect(resolveFilename(filename, cwd)).toBe(expected);
    });

    test.each`
        filename               | cwd          | expected
        ${__filename}          | ${undefined} | ${pathToFileURL(__filename)}
        ${__dirname}           | ${undefined} | ${pathToFileURL(__dirname)}
        ${'not_found'}         | ${__dirname} | ${toFileURL('not_found', __dirname)}
        ${'not_found'}         | ${undefined} | ${pathToFileURL('not_found')}
        ${'stdin'}             | ${undefined} | ${'stdin://'}
        ${'file://file.txt'}   | ${undefined} | ${pathToFileURL('file.txt')}
        ${'stdin://source.ts'} | ${undefined} | ${pathToFileURL('source.ts').href.replace(/^file:/, 'stdin:')}
    `('resolveFilenameToUrl $filename $cwd', async ({ filename, cwd, expected }) => {
        expect(resolveFilenameToUrl(filename, cwd).href).toBe(expected.toString());
    });
});
