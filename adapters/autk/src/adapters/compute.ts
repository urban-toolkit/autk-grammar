import { ComputeAdapter, ComputeSpec, GpgpuComputeSpec, RenderComputeSpec } from '@urban-toolkit/the-urban-grammar';
import type { LayerType } from '@urban-toolkit/the-urban-grammar';
import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkComputeEngine } from '@urban-toolkit/autk-compute';
import { FeatureCollection } from 'geojson';
import { ComputeCache, ComputeLayerTypes } from '../types';
import { computeLayerNames, runCompute } from '../compute-params';

/** The type of the table `name`, which the database knows or an earlier pass wrote. */
function layerTypeOf(db: AutkDb, name: string, types?: ComputeLayerTypes): LayerType | undefined {
    return types?.get(name) ?? db.getTablesMetadata().find((table) => table.name === name)?.type as LayerType | undefined;
}

export function createComputeAdapter(cache?: ComputeCache, types?: ComputeLayerTypes): ComputeAdapter {

    /** Reads a table, from the cache when an earlier pass wrote it there. */
    async function read(db: AutkDb, name: string): Promise<FeatureCollection> {
        return cache?.get(name) ?? await db.getLayer(name);
    }

    /** Stores a pass's result under `outputTableName`, or, without it, in place of the table `source`. */
    function store(db: AutkDb, result: FeatureCollection, source: string, spec: GpgpuComputeSpec | RenderComputeSpec): void {
        if (!cache) return;
        const name = spec.outputTableName ?? source;
        cache.set(name, result);
        const type = spec.layerType ?? layerTypeOf(db, source, types);
        if (spec.outputTableName && type) types?.set(name, type);
    }

    async function resolveRender(db: AutkDb, spec: RenderComputeSpec): Promise<void> {
        const layers = await Promise.all(spec.layers.map(async (layer) => ({
            id: layer.id,
            collection: await read(db, layer.dataRef),
            type: layer.type,
            objectIdProperty: layer.objectIdProperty,
        })));

        const result = await new AutkComputeEngine().renderPipeline({
            layers,
            viewpoints: {
                collection: await read(db, spec.viewpoints.dataRef),
                strategy: spec.viewpoints.strategy,
                sampling: spec.viewpoints.sampling,
            },
            aggregation: spec.aggregation,
            camera: spec.camera,
            tileSize: spec.tileSize,
        });

        store(db, result, spec.viewpoints.dataRef, spec);
    }

    async function resolveGpgpu(db: AutkDb, spec: GpgpuComputeSpec): Promise<void> {
        // A table an earlier compute pass wrote is read from the cache, so passes chain.
        // Only the pass's own table must load; a `fromFeature` table that cannot
        // falls back to the directive's `default`.
        const layers: Record<string, FeatureCollection | undefined> = {};
        for (const name of computeLayerNames(spec)) {
            const cached = cache?.get(name);
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
            if (spec.type === 'render') await resolveRender(context, spec);
            else await resolveGpgpu(context, spec);
            return context;
        }
    }
}
