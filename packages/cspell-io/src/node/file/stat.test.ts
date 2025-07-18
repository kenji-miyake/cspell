import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { getStat, getStatSync } from './stat.js';

const oc = (...params: Parameters<typeof expect.objectContaining>) => expect.objectContaining(...params);
const sc = (m: string) => expect.stringContaining(m);

const timeout = 20_000;

describe('stat', () => {
    test.each`
        url                                                                                      | expected
        ${'https://raw.githubusercontent.com/streetsidesoftware/cspell/main/tsconfig.base.json'} | ${oc({ eTag: sc('W/') })}
        ${__filename}                                                                            | ${oc({ mtimeMs: expect.any(Number) })}
    `(
        'getStat $url',
        async ({ url, expected }) => {
            const r = await getStat(url);
            expect(r).toEqual(expected);
        },
        timeout,
    );

    test.each`
        url                                   | expected
        ${'https://www.google.com/404'}       | ${oc({ message: 'URL not found.', code: 'ENOENT' })}
        ${'https://httpbingo.org/status/503'} | ${oc({ message: 'Fatal Error' })}
        ${join(__dirname, 'not-found.nf')}    | ${oc({ code: 'ENOENT' })}
    `(
        'getStat with error $url',
        async ({ url, expected }) => {
            const r = await getStat(url);
            expect(r).toEqual(expected);
        },
        timeout,
    );

    test.each`
        url           | expected
        ${__filename} | ${oc({ mtimeMs: expect.any(Number) })}
    `('getStatSync $url', ({ url, expected }) => {
        const r = getStatSync(url);
        expect(r).toEqual(expected);
    });

    test.each`
        url                                | expected
        ${'https://www.google.com/404'}    | ${oc({ code: 'ENOENT' })}
        ${join(__dirname, 'not-found.nf')} | ${oc({ code: 'ENOENT' })}
    `(
        'getStatSync with error $url',
        async ({ url, expected }) => {
            const r = await getStatSync(url);
            expect(r).toEqual(expected);
        },
        timeout,
    );
});
