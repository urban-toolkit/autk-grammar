import type { GpgpuComputeSpec, FromFeatureDirective } from '@urban-toolkit/the-urban-grammar';
import type { GpgpuPipelineParams } from '@urban-toolkit/autk-compute';
// A `fromFeature` path is read as autk-map reads a layer's getFnv: key by key, else as a key with dots in it, such as
// the `<table>.<column>` a join writes its aggregates under.
import { valueAtPath } from '@urban-toolkit/autk-core';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

/** Tables a compute pass can read, keyed by table name. */
export type ComputeLayers = Record<string, FeatureCollection | undefined> | Map<string, FeatureCollection>;

/** Runs one GPU dispatch, for example `params => new AutkComputeEngine().gpgpuPipeline(params)`. */
export type ComputeRunner = (params: GpgpuPipelineParams) => Promise<FeatureCollection>;

/**
 * The storage buffer binding every WebGPU device supports: the default
 * `maxStorageBufferBindingSize`, 128 MiB. autk-compute 4 reads each array a `batched` directive
 * packs from a read-only storage buffer of its own, so every packed array must fit one binding.
 * autk-compute 3 bound them as uniform buffers, which hold 64 KiB (2048 bounding boxes).
 */
export const STORAGE_BUFFER_BINDING_SIZE = 134_217_728;

/** Bytes a feature adds to a packed array: one f32 for a scalar entry, a bounding box of eight for a matrix entry. */
const SCALAR_BYTES = 4;
const BOX_BYTES = 8 * 4;

type UniformEntry = number | FromFeatureDirective;
type MatrixEntry = { data: number[][]; cols: number } | FromFeatureDirective;

/** Joins a `wgslFunction` written as an array of lines. Any other separator would let a `//` comment swallow the lines after it. */
export function joinWgsl(body: string | string[]): string {
    return Array.isArray(body) ? body.join('\n') : body;
}

/** True when a uniform entry reads its value from a feature. */
export function isFromFeature(value: unknown): value is FromFeatureDirective {
    return !!value && typeof value === 'object' && !Array.isArray(value)
        && typeof (value as FromFeatureDirective).fromFeature === 'object'
        && (value as FromFeatureDirective).fromFeature !== null;
}

function lookup(layers: ComputeLayers, name: string): FeatureCollection | undefined {
    return layers instanceof Map ? layers.get(name) : layers[name];
}

function directives(block: GpgpuComputeSpec): FromFeatureDirective[] {
    const out: FromFeatureDirective[] = [];
    for (const cfg of [block.uniforms, block.uniformMatrices]) {
        for (const value of Object.values(cfg ?? {})) {
            if (isFromFeature(value)) out.push(value);
        }
    }
    return out;
}

/** Every table a compute pass reads: its `dataRef` plus each `fromFeature` layer. */
export function computeLayerNames(block: GpgpuComputeSpec): string[] {
    return [...new Set([block.dataRef, ...directives(block).map(d => d.fromFeature.layer)])];
}

/**
 * The iteration a compute pass asks for, or `null`. Every iterating directive must read the same
 * layer; the first one found decides the mode and the layer.
 */
export function findIterateSource(block: GpgpuComputeSpec): { mode: 'all' | 'batched'; layer: string } | null {
    for (const d of directives(block)) {
        const { iterate, layer } = d.fromFeature;
        if (iterate === 'all' || iterate === 'batched') return { mode: iterate, layer };
    }
    return null;
}

function resolveDirective(d: FromFeatureDirective, layers: ComputeLayers, iterateIndex?: number): unknown {
    const ff = d.fromFeature;
    const index = iterateIndex !== undefined && ff.iterate === 'all' ? iterateIndex : (ff.index ?? 0);
    const feature = lookup(layers, ff.layer)?.features?.[index];
    return feature ? valueAtPath(feature, ff.path) : undefined;
}

/**
 * Resolves the `fromFeature` entries of `uniforms` to numbers. An entry that does not resolve to a
 * finite number takes its `default`, or is dropped when it has none.
 */
export function resolveUniforms(
    uniforms: Record<string, UniformEntry> | undefined,
    layers: ComputeLayers,
    iterateIndex?: number,
): Record<string, number> | undefined {
    if (!uniforms) return undefined;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(uniforms)) {
        if (!isFromFeature(value)) {
            out[key] = value;
            continue;
        }
        const num = Number(resolveDirective(value, layers, iterateIndex) ?? NaN);
        if (Number.isFinite(num)) out[key] = num;
        else if (typeof value.default === 'number') out[key] = value.default;
    }
    return out;
}

/**
 * Resolves the `fromFeature` entries of `uniformMatrices` to `{ data, cols }`. An entry that does
 * not resolve to an array takes its `default`, or is dropped when it has none.
 */
export function resolveUniformMatrices(
    matrices: Record<string, MatrixEntry> | undefined,
    layers: ComputeLayers,
    iterateIndex?: number,
): Record<string, { data: number[][]; cols: number }> | undefined {
    if (!matrices) return undefined;
    const out: Record<string, { data: number[][]; cols: number }> = {};
    for (const [key, value] of Object.entries(matrices)) {
        if (!isFromFeature(value)) {
            out[key] = value;
            continue;
        }
        const resolved = resolveDirective(value, layers, iterateIndex);
        const data = Array.isArray(resolved) ? (resolved as number[][])
            : Array.isArray(value.default) ? value.default : undefined;
        if (!data) continue;
        const cols = value.cols ?? (Array.isArray(data[0]) ? data[0].length : 0);
        if (cols > 0) out[key] = { data, cols };
        else console.warn(`[autk-grammar] uniform matrix "${key}" has no column count; entry dropped`);
    }
    return out;
}

function isFiniteValue(v: unknown): boolean {
    return v !== undefined && v !== null && !(typeof v === 'number' && !Number.isFinite(v));
}

function isBatched(value: unknown): boolean {
    return isFromFeature(value) && value.fromFeature.iterate === 'batched';
}

/** True when a batched entry reads a feature's geometry, as `geometry.coordinates.0` reads a polygon's outer ring. */
function batchedReadsGeometry(...entries: Array<Record<string, UniformEntry | MatrixEntry> | undefined>): boolean {
    return entries.some((cfg) => Object.values(cfg ?? {}).some((value) =>
        isFromFeature(value) && value.fromFeature.iterate === 'batched' && String(value.fromFeature.path).startsWith('geometry.')));
}

/**
 * The features a batched entry that reads the geometry packs for `feature`: one for each polygon of a MultiPolygon,
 * and of a GeometryCollection, nested collections included, each a Polygon with the feature's properties. A member of
 * a GeometryCollection takes its part's properties over them too, from the `properties.parts` entry whose
 * `geometryIndex` is its place, as autk-db keeps a building. Any other feature, and one with no polygon, is as it is.
 */
function polygonsOf(feature: Feature): Feature[] {
    const geometry = feature.geometry;
    const asPolygon = (properties: Feature['properties'], coordinates: number[][][]): Feature =>
        ({ ...feature, properties, geometry: { type: 'Polygon', coordinates } });
    if (geometry?.type === 'MultiPolygon') {
        return geometry.coordinates.length > 0
            ? geometry.coordinates.map((coordinates) => asPolygon(feature.properties, coordinates))
            : [feature];
    }
    if (geometry?.type !== 'GeometryCollection') return [feature];
    const { parts, ...shared } = (feature.properties ?? {}) as Record<string, unknown>;
    const partAt = (index: number): Record<string, unknown> | undefined => (Array.isArray(parts)
        ? parts.find((part) => part !== null && typeof part === 'object' && (part as Record<string, unknown>).geometryIndex === index)
        : undefined);
    const out: Feature[] = [];
    const collect = (member: Geometry, properties: Feature['properties']): void => {
        if (member.type === 'Polygon') out.push(asPolygon(properties, member.coordinates));
        else if (member.type === 'MultiPolygon') member.coordinates.forEach((coordinates) => out.push(asPolygon(properties, coordinates)));
        else if (member.type === 'GeometryCollection') member.geometries.forEach((nested) => collect(nested, properties));
    };
    geometry.geometries.forEach((member, index) => {
        const part = partAt(index);
        collect(member, part ? { ...shared, ...part } : feature.properties);
    });
    return out.length > 0 ? out : [feature];
}

/** Bytes one feature adds to the largest array a batched pass packs, or 0 when it packs none. */
function batchedBytesPerFeature(
    uniforms: Record<string, UniformEntry> | undefined,
    matrices: Record<string, MatrixEntry> | undefined,
): number {
    if (Object.values(matrices ?? {}).some(isBatched)) return BOX_BYTES;
    if (Object.values(uniforms ?? {}).some(isBatched)) return SCALAR_BYTES;
    return 0;
}

/**
 * Most features a batched pass packs: as many as its largest array holds in one storage buffer
 * binding of `bindingSize` bytes. With {@link STORAGE_BUFFER_BINDING_SIZE} that is 4,194,304
 * features for a pass with a matrix entry, and 33,554,432 for one with scalar entries only.
 */
export function maxBatchedFeatures(
    uniforms: Record<string, UniformEntry> | undefined,
    matrices: Record<string, MatrixEntry> | undefined,
    bindingSize: number = STORAGE_BUFFER_BINDING_SIZE,
): number {
    const bytes = batchedBytesPerFeature(uniforms, matrices);
    return bytes > 0 ? Math.floor(bindingSize / bytes) : Number.POSITIVE_INFINITY;
}

/**
 * Packs every feature of a `batched` layer into uniform arrays:
 * - a scalar entry becomes an array of one value per feature, under the entry's name;
 * - a matrix entry becomes each feature's axis-aligned bounding box as four corners
 *   `[xmin,ymin, xmax,ymin, xmax,ymax, xmin,ymax]`, eight values per feature;
 * - `num_features` holds the feature count.
 * When an entry reads the geometry (a path that starts with `geometry.`), each polygon of a
 * MultiPolygon or of a GeometryCollection is packed as a feature of its own, with its part's
 * properties (see {@link polygonsOf}): `geometry.coordinates.0` then reads every polygon's
 * outer ring, and the scalar entries repeat beside it. Features missing a `required` path are
 * dropped next, and at most {@link maxBatchedFeatures} are packed: as many as the largest array
 * holds in one storage buffer binding of `bindingSize` bytes. Plain numbers pass through; other
 * entries that do not iterate are left to {@link resolveComputeParams}.
 */
export function buildBatchedUniforms(
    uniforms: Record<string, UniformEntry> | undefined,
    matrices: Record<string, MatrixEntry> | undefined,
    sources: Feature[],
    bindingSize: number = STORAGE_BUFFER_BINDING_SIZE,
): { uniforms: Record<string, number>; uniformArrays: Record<string, number[]> } {
    const outUniforms: Record<string, number> = {};
    const outArrays: Record<string, number[]> = {};

    // A polygon's own tags decide whether it has a `required` value, so it is a feature of its own before the filter.
    if (batchedReadsGeometry(uniforms, matrices)) sources = sources.flatMap(polygonsOf);

    const required: string[] = [];
    for (const cfg of [uniforms, matrices]) {
        for (const value of Object.values(cfg ?? {})) {
            if (isFromFeature(value) && value.fromFeature.iterate === 'batched' && value.fromFeature.required) {
                required.push(value.fromFeature.path);
            }
        }
    }
    if (required.length > 0) {
        const before = sources.length;
        sources = sources.filter(f => required.every(p => isFiniteValue(valueAtPath(f, p))));
        if (sources.length < before) {
            console.info(`[autk-grammar] batched compute dropped ${before - sources.length} feature(s) missing ${required.join(', ')}`);
        }
    }
    const limit = maxBatchedFeatures(uniforms, matrices, bindingSize);
    if (sources.length > limit) {
        console.warn(
            `[autk-grammar] batched compute capped at ${limit} features (got ${sources.length}): `
            + `its largest packed array takes ${batchedBytesPerFeature(uniforms, matrices)} B per feature, `
            + `and a storage buffer binding holds ${bindingSize} B`,
        );
        sources = sources.slice(0, limit);
    }

    for (const [key, value] of Object.entries(uniforms ?? {})) {
        if (isFromFeature(value) && value.fromFeature.iterate === 'batched') {
            const fallback = typeof value.default === 'number' ? value.default : undefined;
            outArrays[key] = sources.map(f => {
                const num = Number(valueAtPath(f, value.fromFeature.path) ?? fallback);
                return Number.isFinite(num) ? num : 0;
            });
        } else if (typeof value === 'number') {
            outUniforms[key] = value;
        }
    }

    for (const [key, value] of Object.entries(matrices ?? {})) {
        if (!isFromFeature(value) || value.fromFeature.iterate !== 'batched') continue;
        const data: number[] = [];
        for (const f of sources) {
            const ring = valueAtPath(f, value.fromFeature.path);
            let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
            if (Array.isArray(ring)) {
                for (const coord of ring) {
                    if (!Array.isArray(coord) || coord.length < 2) continue;
                    const x = Number(coord[0]);
                    const y = Number(coord[1]);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    xmin = Math.min(xmin, x); ymin = Math.min(ymin, y);
                    xmax = Math.max(xmax, x); ymax = Math.max(ymax, y);
                }
            }
            // A degenerate feature gets a zero-area box, so the shader's loop runs but adds nothing.
            if (!Number.isFinite(xmin)) { xmin = 0; ymin = 0; xmax = 0; ymax = 0; }
            data.push(xmin, ymin, xmax, ymin, xmax, ymax, xmin, ymax);
        }
        outArrays[key] = data;
    }

    outUniforms.num_features = sources.length;
    return { uniforms: outUniforms, uniformArrays: outArrays };
}

/**
 * The table a pass runs over as autk-compute reads it. autk-compute packs a matrix attribute row
 * by row, and the rows of a MultiLineString's `geometry.coordinates` are lines, not points, so
 * when an attribute reads the geometry each MultiLineString is handed as one LineString of its
 * lines' points, in their order. Every other feature is the same object, and so is the table when
 * it holds no MultiLineString or no attribute reads the geometry. {@link runCompute} gives each
 * feature of the result its own geometry back.
 */
function asComputeReadsIt(block: GpgpuComputeSpec, collection: FeatureCollection): FeatureCollection {
    if (!Object.values(block.attributes ?? {}).some((path) => String(path).startsWith('geometry.'))) return collection;
    let joined = false;
    const features = collection.features.map((feature) => {
        if (feature.geometry?.type !== 'MultiLineString') return feature;
        joined = true;
        return { ...feature, geometry: { type: 'LineString' as const, coordinates: feature.geometry.coordinates.flat() } };
    });
    return joined ? { ...collection, features } : collection;
}

/** *result*, computed from *handed* (`asComputeReadsIt` of *collection*), with each feature's own geometry of *collection*. */
function withOwnGeometries(result: FeatureCollection, collection: FeatureCollection, handed: FeatureCollection): FeatureCollection {
    if (handed === collection) return result;
    return {
        ...result,
        features: result.features.map((feature, i) => (handed.features[i] === collection.features[i]
            ? feature
            : { ...feature, geometry: collection.features[i].geometry })),
    };
}

/**
 * Turns a compute pass into the parameters of one GPU dispatch. Pure: it reads `layers` and runs
 * nothing. With `iterate: 'all'`, pass the feature index as `iterateIndex` for each dispatch (see
 * {@link runCompute}). Throws when the pass's `dataRef` is not in `layers`. When an attribute
 * reads the geometry, the table it hands autk-compute holds each MultiLineString as one
 * LineString of its points ({@link runCompute} gives the result its own geometries back).
 */
export function resolveComputeParams(block: GpgpuComputeSpec, layers: ComputeLayers, iterateIndex?: number): GpgpuPipelineParams {
    const collection = lookup(layers, block.dataRef);
    if (!collection) throw new Error(`compute: table "${block.dataRef}" is not loaded`);

    const params: GpgpuPipelineParams = {
        collection: asComputeReadsIt(block, collection),
        variableMapping: block.attributes,
        wgslBody: joinWgsl(block.wgslFunction),
    };
    if (block.attributeArrays) params.attributeArrays = block.attributeArrays;
    if (block.attributeMatrices) params.attributeMatrices = block.attributeMatrices;
    if (block.uniformArrays) params.uniformArrays = block.uniformArrays;
    if (block.outputColumnName) params.resultField = block.outputColumnName;
    if (block.outputColumns) params.outputColumns = block.outputColumns;

    const iterate = findIterateSource(block);
    if (iterate?.mode === 'batched') {
        const sources = lookup(layers, iterate.layer)?.features ?? [];
        const packed = buildBatchedUniforms(block.uniforms, block.uniformMatrices, sources);
        // Entries that do not iterate resolve as they would without iteration.
        const single = resolveUniforms(notBatched(block.uniforms), layers) ?? {};
        const matrices = resolveUniformMatrices(notBatched(block.uniformMatrices), layers);
        params.uniforms = { ...single, ...packed.uniforms };
        params.uniformArrays = { ...(params.uniformArrays ?? {}), ...packed.uniformArrays };
        if (matrices && Object.keys(matrices).length > 0) params.uniformMatrices = matrices;
        return params;
    }

    const index = iterate?.mode === 'all' ? iterateIndex : undefined;
    const uniforms = resolveUniforms(block.uniforms, layers, index);
    const matrices = resolveUniformMatrices(block.uniformMatrices, layers, index);
    if (uniforms) params.uniforms = uniforms;
    if (matrices) params.uniformMatrices = matrices;
    return params;
}

function notBatched<T>(entries: Record<string, T> | undefined): Record<string, T> | undefined {
    if (!entries) return undefined;
    return Object.fromEntries(Object.entries(entries).filter(([, v]) => !(isFromFeature(v) && v.fromFeature.iterate === 'batched')));
}

function outputColumns(block: GpgpuComputeSpec): string[] {
    return block.outputColumns ?? (block.outputColumnName ? [block.outputColumnName] : []);
}

/**
 * Runs a compute pass. Without iteration, or with `batched`, that is one dispatch. With `all` it is
 * one dispatch per feature of the iterated layer, and each output column holds the sum over them.
 * Each feature of the result keeps its own geometry, whatever autk-compute was handed.
 */
export async function runCompute(block: GpgpuComputeSpec, layers: ComputeLayers, run: ComputeRunner): Promise<FeatureCollection> {
    const iterate = findIterateSource(block);
    if (iterate?.mode !== 'all') {
        const params = resolveComputeParams(block, layers);
        return withOwnGeometries(await run(params), lookup(layers, block.dataRef)!, params.collection);
    }

    const target = lookup(layers, block.dataRef);
    if (!target) throw new Error(`compute: table "${block.dataRef}" is not loaded`);
    const columns = outputColumns(block);
    const summed: FeatureCollection = structuredClone(target);
    for (const f of summed.features) {
        const props = (f.properties ??= {}) as Record<string, unknown>;
        const compute = (props.compute ??= {}) as Record<string, number>;
        for (const col of columns) compute[col] = 0;
    }

    const count = lookup(layers, iterate.layer)?.features?.length ?? 0;
    for (let i = 0; i < count; i++) {
        // The sums' features hand autk-compute the table as it reads it; the sums keep their own geometries.
        const step = await run({ ...resolveComputeParams(block, layers, i), collection: asComputeReadsIt(block, summed) });
        summed.features.forEach((f, j) => {
            const dst = (f.properties as Record<string, unknown> | null)?.compute as Record<string, number> | undefined;
            const src = (step.features[j]?.properties as Record<string, unknown> | null)?.compute as Record<string, unknown> | undefined;
            if (!dst || !src) return;
            for (const col of columns) {
                const inc = Number(src[col]);
                if (Number.isFinite(inc)) dst[col] += inc;
            }
        });
    }
    return summed;
}
