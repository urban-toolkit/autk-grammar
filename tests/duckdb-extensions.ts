import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';

/**
 * DuckDB's extensions for the browser tests, from a copy on disk, so no test needs extensions.duckdb.org.
 *
 * The DuckDB that autk-db runs in the page fetches an extension from that host each time a database loads one: `spatial`
 * when autk-db's `init()` starts, `json` the first time a query reads JSON, as autk-db's queries of feature properties
 * do. Every test starts a database, so a run fetched them about two hundred times, and one failed fetch failed a test.
 *
 * Instead, each test's page has the requests to the host answered from `tests/.duckdb-extensions`, laid out as the
 * host's paths (`v1.5.4/wasm_eh/spatial.duckdb_extension.wasm`), and a request the copy cannot answer fails. The copy is
 * fetched before the tests: by the E2E workflow, which keeps it in the Actions cache under the DuckDB build's version,
 * and by Playwright's global setup, which fetches only what is missing.
 */

/** The host DuckDB fetches its extensions from. */
export const EXTENSION_HOST = 'https://extensions.duckdb.org';

/** The extensions a test run loads. */
export const EXTENSIONS = ['spatial', 'json'];

/** The copy, laid out as the host's paths. */
export const EXTENSIONS_DIR = path.join(__dirname, '.duckdb-extensions');

/** An extension's path on the host and in the copy: `<version>/<platform>/<name>.duckdb_extension.wasm`. */
function extensionPath(version: string, platform: string, name: string): string {
    return `${version}/${platform}/${name}.duckdb_extension.wasm`;
}

/** The file of the copy that answers a request to the host, or `undefined` for a URL that names no extension. */
function fileOf(url: string): string | undefined {
    const match = /^\/([\w.-]+)\/(wasm_\w+)\/(\w+)\.duckdb_extension\.wasm$/.exec(new URL(url).pathname);
    return match ? path.join(EXTENSIONS_DIR, extensionPath(match[1], match[2], match[3])) : undefined;
}

/**
 * The DuckDB version and platform of the wasm build autk-db's browser bundle loads (its `dist/duckdb-eh.wasm`), which
 * name the extensions' paths. Read in Node through the blocking bundle of the duckdb-wasm autk-db imports, with no
 * extension loaded, so with no request to the host.
 */
export async function duckdbBuild(): Promise<{ version: string, platform: string }> {
    const dist = path.dirname(require.resolve('@urban-toolkit/autk-db'));
    const duckdb = require(require.resolve('@duckdb/duckdb-wasm/blocking', { paths: [dist] })) as typeof import('@duckdb/duckdb-wasm/blocking');
    const db = await duckdb.createDuckDB({
        mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
        eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
    }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    const connection = db.connect();
    try {
        const [row] = connection.query('SELECT version() AS version, (SELECT platform FROM pragma_platform()) AS platform').toArray();
        return { version: String(row.version), platform: String(row.platform) };
    } finally {
        connection.close();
    }
}

/** The key of the copy in the Actions cache: the DuckDB build, and the extensions it holds. */
export async function cacheKey(): Promise<string> {
    const { version, platform } = await duckdbBuild();
    return `duckdb-extensions-${version}-${platform}-${EXTENSIONS.join('-')}`;
}

/** Fetches `url` into `file`, trying five times; a file is only ever written whole. */
async function download(url: string, file: string): Promise<void> {
    const tries = 5;
    const errors: string[] = [];
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error('the answer is not a WebAssembly module');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(`${file}.part`, bytes);
            fs.renameSync(`${file}.part`, file);
            return;
        } catch (error) {
            errors.push(`try ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
            if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
        }
    }
    throw new Error(`Could not fetch ${url} (${errors.join('; ')}).`);
}

/** Fetches into the copy each extension of {@link EXTENSIONS} it does not hold for the DuckDB build autk-db loads. */
export async function fetchExtensions(): Promise<void> {
    const { version, platform } = await duckdbBuild();
    for (const name of EXTENSIONS) {
        const relative = extensionPath(version, platform, name);
        const file = path.join(EXTENSIONS_DIR, relative);
        if (fs.existsSync(file)) continue;
        await download(`${EXTENSION_HOST}/${relative}`, file);
        console.log(`Fetched ${relative} into tests/.duckdb-extensions (${fs.statSync(file).size} bytes).`);
    }
}

/** What a page asked of the extension host: the extensions the copy answered, and the URLs it could not. */
export type ExtensionRequests = { served: string[], missing: string[] };

/**
 * Answers the page's requests to the extension host from the copy, as the host would, and fails each request the copy
 * cannot answer, which it lists in `missing`. A page route, so it answers before any route of the page's context.
 */
export async function serveExtensions(page: Page): Promise<ExtensionRequests> {
    const requests: ExtensionRequests = { served: [], missing: [] };
    await page.route(`${EXTENSION_HOST}/**`, async (route) => {
        const url = route.request().url();
        const file = fileOf(url);
        if (!file || !fs.existsSync(file)) {
            requests.missing.push(url);
            await route.abort('internetdisconnected');
            return;
        }
        requests.served.push(path.basename(file, '.duckdb_extension.wasm'));
        // DuckDB's worker fetches the extension from the page's origin, so the answer allows any origin, as the host's does.
        await route.fulfill({ path: file, contentType: 'application/wasm', headers: { 'access-control-allow-origin': '*' } });
    });
    return requests;
}

/** Playwright's global setup: the copy holds every extension before the first test. */
export default async function globalSetup(): Promise<void> {
    await fetchExtensions();
}

// The E2E workflow's steps: `tsx tests/duckdb-extensions.ts key` prints the cache key as a step output, and
// `tsx tests/duckdb-extensions.ts fetch` fills the copy.
if (require.main === module) {
    const command = process.argv[2];
    const work = command === 'key' ? cacheKey().then((key) => console.log(`key=${key}`))
        : command === 'fetch' ? fetchExtensions()
            : Promise.reject(new Error(`Usage: tsx tests/duckdb-extensions.ts key|fetch, not ${JSON.stringify(command)}.`));
    work.catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
