import { assert } from '../errors/assert.js';
import type { BufferEncoding } from '../models/BufferEncoding.js';
import type { FileReference, FileResource, TextFileResource } from '../models/FileResource.js';
import { decode, encodeString, isGZipped } from './encode-decode.js';

export interface CFileResourceJson {
    url: string;
    content: string;
    encoding?: string | undefined;
    baseFilename?: string | undefined;
    gz: boolean;
}

export class CFileResource implements TextFileResource {
    private _text?: string;
    readonly baseFilename?: string | undefined;
    private _gz?: boolean | undefined;

    constructor(
        readonly url: URL,
        readonly content: string | ArrayBufferView,
        readonly encoding: BufferEncoding | undefined,
        baseFilename: string | undefined,
        gz: boolean | undefined,
    ) {
        this.baseFilename = baseFilename ?? ((url.protocol !== 'data:' && url.pathname.split('/').pop()) || undefined);
        this._gz = gz;
    }

    get gz(): boolean {
        if (this._gz !== undefined) return this._gz;
        if (this.url.pathname.endsWith('.gz')) return true;
        if (typeof this.content === 'string') return false;
        return isGZipped(this.content);
    }

    getText(encoding?: BufferEncoding): string {
        if (this._text !== undefined) return this._text;
        const text = typeof this.content === 'string' ? this.content : decode(this.content, encoding ?? this.encoding);
        this._text = text;
        return text;
    }

    getBytes(): Uint8Array {
        const arrayBufferview =
            typeof this.content === 'string' ? encodeString(this.content, this.encoding) : this.content;
        return arrayBufferview instanceof Uint8Array
            ? arrayBufferview
            : new Uint8Array(arrayBufferview.buffer, arrayBufferview.byteOffset, arrayBufferview.byteLength);
    }

    public toJson(): CFileResourceJson {
        return {
            url: this.url.href,
            content: this.getText(),
            encoding: this.encoding,
            baseFilename: this.baseFilename,
            gz: this.gz,
        };
    }

    static isCFileResource(obj: unknown): obj is CFileResource {
        return obj instanceof CFileResource;
    }

    static from(fileResource: FileResource): CFileResource;
    static from(fileReference: FileReference, content: string | ArrayBufferView): CFileResource;
    static from(fileReference: FileReference | URL, content: string | ArrayBufferView): CFileResource;
    static from(
        url: URL,
        content: string | ArrayBufferView,
        encoding?: BufferEncoding | undefined,
        baseFilename?: string | undefined,
        gz?: boolean,
    ): CFileResource;
    static from(
        urlOrFileResource: FileResource | FileReference | URL,
        content?: string | ArrayBufferView,
        encoding?: BufferEncoding,
        baseFilename?: string | undefined,
        gz?: boolean,
    ): CFileResource {
        if (CFileResource.isCFileResource(urlOrFileResource)) {
            if (content) {
                const { url, encoding, baseFilename, gz } = urlOrFileResource;
                return new CFileResource(url, content, encoding, baseFilename, gz);
            }
            return urlOrFileResource;
        }
        if (urlOrFileResource instanceof URL) {
            assert(content !== undefined);
            return new CFileResource(urlOrFileResource, content, encoding, baseFilename, gz);
        }
        if (content !== undefined) {
            const fileRef = urlOrFileResource;
            return new CFileResource(fileRef.url, content, fileRef.encoding, fileRef.baseFilename, fileRef.gz);
        }
        assert('content' in urlOrFileResource && urlOrFileResource.content !== undefined);
        const fileResource = urlOrFileResource;
        return new CFileResource(
            fileResource.url,
            fileResource.content,
            fileResource.encoding,
            fileResource.baseFilename,
            fileResource.gz,
        );
    }
}

export function fromFileResource(fileResource: FileResource, encoding?: BufferEncoding): TextFileResource {
    return CFileResource.from(encoding ? { ...fileResource, encoding } : fileResource);
}

export function renameFileResource(fileResource: FileResource, url: URL): FileResource {
    return CFileResource.from({ ...fileResource, url });
}
