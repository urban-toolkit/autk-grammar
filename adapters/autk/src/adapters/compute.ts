import { ClustersComputeSpec, ComputeAdapter, ComputeSpec, GpgpuComputeSpec, RenderComputeSpec, WindowsComputeSpec } from '@urban-toolkit/the-urban-grammar';
import type { LayerType, RenderLayerSpec, WorkspaceName } from '@urban-toolkit/the-urban-grammar';
import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkComputeEngine } from '@urban-toolkit/autk-compute';
import { FeatureCollection } from 'geojson';
import { ComputeCache, ComputeLayerTypes, GeoJsonCache } from '../types';
import { computeLayerNames, runCompute } from '../compute-params';
import { clustersTable, windowsTable } from '../compute-tables';
import { enterWorkspace, inWorkspaceCrs, tableKey } from '../workspace';

/**
 * The layer types a render pass draws. autk-compute skips a layer of any other type, points among them, with only a
 * warning, so the adapter refuses one.
 */
const RENDER_LAYER_TYPES: ReadonlyArray<RenderLayerSpec['type']> = ['surface', 'parks', 'water', 'roads', 'buildings', 'polygons', 'polylines'];

/** The type of the table `name`, which the database knows or an earlier pass wrote. */
function layerTypeOf(db: AutkDb, name: string, workspace: string | undefined, types?: ComputeLayerTypes): LayerType | undefined {
    return types?.get(tableKey(workspace, name)) ?? db.getTablesMetadata().find((table) => table.name === name)?.type as LayerType | undefined;
}

/**
 * The compute adapter `AutkGrammar` runs. Its `resolveCompute(db, pass)` runs one entry of a spec's `compute`, in the
 * pass's workspace, which it leaves current: a GPGPU pass or a render pass on autk-compute, or a windows or clusters
 * pass on the CPU through autk-core. It does nothing without a database.
 *
 * A host calls it to run compute passes exactly as the grammar does. GPGPU and render passes need WebGPU, and results are
 * kept only in the caches: `cache` receives each pass's result under {@link tableKey} of its `outputTableName`, or of
 * the table it computed over, and a later pass reads a table from it first. `types` receives the layer type of each
 * table a pass wrote under its own `outputTableName`, which a map needs to draw it. `sources` is the cache the data
 * adapter fills: a pass reads a `fromFeature` table from it next, as its plots read theirs, when a GeoJSON source put
 * the table there with its coordinates in the workspace's CRS.
 */
export function createComputeAdapter(cache?: ComputeCache, types?: ComputeLayerTypes, sources?: GeoJsonCache): ComputeAdapter {

    /** Reads a table, from the cache when an earlier pass wrote it there. */
    async function read(db: AutkDb, name: string, workspace?: string): Promise<FeatureCollection> {
        return cache?.get(tableKey(workspace, name)) ?? await db.getLayer(name);
    }

    /**
     * Stores a pass's result under `outputTableName`, or, without it, in place of the table `source`. A map draws a
     * new table as the spec's `layerType` says, else as `resultType`, else as it draws `source`.
     */
    function store(
        db: AutkDb, result: FeatureCollection, source: string,
        spec: { workspace?: WorkspaceName; outputTableName?: string; layerType?: LayerType }, resultType?: LayerType,
    ): void {
        if (!cache) return;
        const name = spec.outputTableName ?? source;
        cache.set(tableKey(spec.workspace, name), result);
        const type = spec.layerType ?? resultType ?? layerTypeOf(db, source, spec.workspace, types);
        if (spec.outputTableName && type) types?.set(tableKey(spec.workspace, name), type);
    }

    async function resolveRender(db: AutkDb, spec: RenderComputeSpec): Promise<void> {
        for (const layer of spec.layers) {
            if (!(RENDER_LAYER_TYPES as readonly string[]).includes(layer.type))
                throw new Error(`Render pass "${spec.outputTableName}": layer "${layer.id}" has the type "${layer.type}", which a render pass cannot draw. A layer's type is one of ${RENDER_LAYER_TYPES.join(', ')}.`);
        }

        const layers = await Promise.all(spec.layers.map(async (layer) => ({
            id: layer.id,
            collection: await read(db, layer.dataRef, spec.workspace),
            type: layer.type,
            objectIdProperty: layer.objectIdProperty,
        })));

        const result = await new AutkComputeEngine().renderPipeline({
            layers,
            viewpoints: {
                collection: await read(db, spec.viewpoints.dataRef, spec.workspace),
                strategy: spec.viewpoints.strategy,
                sampling: spec.viewpoints.sampling,
            },
            aggregation: spec.aggregation,
            camera: spec.camera,
            tileSize: spec.tileSize,
        });

        // With `building-windows` the result holds one point per window, not the viewpoints' features.
        store(db, result, spec.viewpoints.dataRef, spec, spec.viewpoints.strategy?.type === 'building-windows' ? 'points' : undefined);
    }

    async function resolveWindows(db: AutkDb, spec: WindowsComputeSpec): Promise<void> {
        const refuse = (message: string) => new Error(`Windows pass "${spec.outputTableName}": ${message}`);
        if (typeof spec.floors !== 'number' || !Number.isFinite(spec.floors))
            throw refuse(`floors must be a number of rows of windows, not ${JSON.stringify(spec.floors)}.`);
        // The buildings are read as a render pass reads its viewpoints, so the windows are those its building-windows
        // strategy renders from.
        const buildings = await read(db, spec.dataRef, spec.workspace);
        let windows: FeatureCollection;
        try {
            windows = windowsTable(buildings, spec.floors);
        } catch (error) {
            throw refuse(`autk-core places no windows on "${spec.dataRef}": ${error instanceof Error ? error.message : String(error)}`);
        }
        store(db, windows, spec.dataRef, spec, 'points');
    }

    async function resolveClusters(db: AutkDb, spec: ClustersComputeSpec): Promise<void> {
        if (typeof spec.outputColumnName !== 'string' || spec.outputColumnName === '')
            throw new Error(`Clusters pass over "${spec.dataRef}": outputColumnName must name the column of the cluster ids, not ${JSON.stringify(spec.outputColumnName)}.`);
        // The table is read as a GPGPU pass reads its own: as an earlier pass wrote it, else as autk-db keeps it.
        const table = await read(db, spec.dataRef, spec.workspace);
        store(db, clustersTable(table, spec.outputColumnName), spec.dataRef, spec);
    }

    async function resolveGpgpu(db: AutkDb, spec: GpgpuComputeSpec): Promise<void> {
        // A table an earlier compute pass wrote is read from the cache, so passes chain.
        // Only the pass's own table must load; a `fromFeature` table that cannot
        // falls back to the directive's `default`.
        const layers: Record<string, FeatureCollection | undefined> = {};
        const workspaceCrs = db.getWorkspaceConfiguration().coordinateFormat;
        for (const name of computeLayerNames(spec)) {
            const key = tableKey(spec.workspace, name);
            // A `fromFeature` table a GeoJSON source loaded is read as the source gave it, as the plots read theirs:
            // autk-db keeps each feature of a buildings table in its building model, the geometry inside a
            // GeometryCollection, where `geometry.coordinates.0` finds no outline. The pass's own table is read as autk-db
            // keeps it, as a map draws it, so its result holds the rows the map draws.
            const cached = cache?.get(key) ?? (name === spec.dataRef ? undefined : inWorkspaceCrs(sources?.get(key), workspaceCrs));
            if (cached) layers[name] = cached;
            else if (name === spec.dataRef) layers[name] = await db.getLayer(name);
            else {
                try { layers[name] = await db.getLayer(name); }
                catch { layers[name] = undefined; }
            }
        }

        const engine = new AutkComputeEngine();
        const result = await runCompute(spec, layers, params => engine.gpgpuPipeline(params));

        store(db, result, spec.dataRef, spec);
    }

    return {
        async resolveCompute(context: AutkDb | undefined, spec: ComputeSpec): Promise<AutkDb | undefined> {
            if (!context) return;
            await enterWorkspace(context, spec.workspace);
            if (spec.type === 'render') await resolveRender(context, spec);
            else if (spec.type === 'windows') await resolveWindows(context, spec);
            else if (spec.type === 'clusters') await resolveClusters(context, spec);
            else await resolveGpgpu(context, spec);
            return context;
        }
    }
}
