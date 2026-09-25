import { ComputeAdapter, ComputeSpec } from '@urban-toolkit/the-urban-grammar';
import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkComputeEngine } from '@urban-toolkit/autk-compute';
import { FeatureCollection } from 'geojson';
import { ComputeCache } from '../types';
import { computeLayerNames, runCompute } from '../compute-params';

export function createComputeAdapter(cache?: ComputeCache): ComputeAdapter {

    return {
        async resolveCompute(context: AutkDb | undefined, spec: ComputeSpec): Promise<AutkDb | undefined> {
            if(context){
                // A table an earlier compute pass wrote is read from the cache, so passes chain.
                // Only the pass's own table must load; a `fromFeature` table that cannot
                // falls back to the directive's `default`.
                const layers: Record<string, FeatureCollection | undefined> = {};
                for (const name of computeLayerNames(spec)) {
                    const cached = cache?.get(name);
                    if (cached) layers[name] = cached;
                    else if (name === spec.dataRef) layers[name] = await context.getLayer(name);
                    else {
                        try { layers[name] = await context.getLayer(name); }
                        catch { layers[name] = undefined; }
                    }
                }

                const engine = new AutkComputeEngine();
                const result = await runCompute(spec, layers, params => engine.gpgpuPipeline(params));

                if (cache) cache.set(spec.dataRef, result);

                return context;
            }
        }
    }
}
