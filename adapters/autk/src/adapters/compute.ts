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
                const layers: Record<string, FeatureCollection> = {};
                for (const name of computeLayerNames(spec)) {
                    layers[name] = cache?.get(name) ?? await context.getLayer(name);
                }

                const engine = new AutkComputeEngine();
                const result = await runCompute(spec, layers, params => engine.gpgpuPipeline(params));

                if (cache) cache.set(spec.dataRef, result);

                return context;
            }
        }
    }
}
