import type { DataAdapter, MapAdapter, PlotAdapter, ComputeAdapter, IEngine, UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { createEngine } from '@urban-toolkit/the-urban-grammar';
import { createDataAdapter } from './adapters/data';
import { createMapAdapter } from './adapters/map';
import { createPlotAdapter } from './adapters/plot';
import { createComputeAdapter } from './adapters/compute';
import { Targets, DeckRegistry, GeoJsonCache } from './types';

export class DeckGlGrammar {
    private dataAdapter?: DataAdapter;
    private mapAdapter?: MapAdapter;
    private plotAdapter?: PlotAdapter;
    private computeAdapter?: ComputeAdapter;
    private grammarEngine?: IEngine;

    constructor(targets?: Targets) {
        const registry: DeckRegistry = new Map();
        const cache: GeoJsonCache = new Map();

        this.dataAdapter = createDataAdapter(targets, cache);
        this.mapAdapter = createMapAdapter(targets, registry);
        this.plotAdapter = createPlotAdapter(targets, cache);
        this.computeAdapter = createComputeAdapter();
    }

    async run(spec: UrbanSpec): Promise<void> {
        if (!this.dataAdapter)
            throw new Error('Data adapter not initialized.');
        if (!this.mapAdapter)
            throw new Error('Map adapter not initialized.');
        if (!this.plotAdapter)
            throw new Error('Plot adapter not initialized.');
        if (!this.computeAdapter)
            throw new Error('Compute adapter not initialized.');

        this.grammarEngine = createEngine({
            spec,
            adapters: {
                db: this.dataAdapter,
                map: this.mapAdapter,
                plot: this.plotAdapter,
                compute: this.computeAdapter,
            },
        });

        await this.grammarEngine.run();
    }
}
