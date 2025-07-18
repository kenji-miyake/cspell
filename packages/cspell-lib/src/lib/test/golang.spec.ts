import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, test } from 'vitest';

import { pathPackageSamples } from '../../test-util/test.locations.js';
import * as cspell from '../index.js';

const sampleFilename = path.join(pathPackageSamples, 'src/sample.go');
const sampleFile = fsp.readFile(sampleFilename, 'utf8').then((buffer) => buffer.toString());

const timeout = 10_000;

describe('Validate that Go files are correctly checked.', () => {
    test('Tests the default configuration', { timeout }, async () => {
        const text = await sampleFile;
        expect(Object.keys(text)).not.toHaveLength(0);
        const ext = '.go';
        const languageIds = cspell.getLanguagesForExt(ext);
        const settings = await cspell.getDefaultBundledSettingsAsync();
        const fileSettings = cspell.combineTextAndLanguageSettings(settings, text, languageIds);
        // cspell:ignore weirdd garbbage longname
        const results1 = await cspell.validateText('some weirdd garbbage', fileSettings);
        expect(results1.map((t) => t.text)).toEqual(expect.arrayContaining(['weirdd']));
        expect(results1.map((t) => t.text)).toEqual(expect.arrayContaining(['garbbage']));
        const results = await cspell.validateText(text, fileSettings);
        expect(results).toHaveLength(3);
        expect(results.map((t) => t.text)).toEqual(expect.arrayContaining(['longname', 'garbbage']));
    });
});
