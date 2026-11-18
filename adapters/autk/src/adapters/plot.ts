import { PlotAdapter, PlotSpec, PlotMark } from '@urban-toolkit/the-urban-grammar';
import { enterWorkspace, tableKey } from '../workspace';
import { Targets, MapRegistry, MapLayerIds, PlotRegistry, PlotMapLinks, GeoJsonCache, ComputeCache } from '../types';
import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkPlot, PlotEvent as AutkPlotEvent } from '@urban-toolkit/autk-plot';
import type { PlotEventData, PlotType, PlotTransformConfig } from '@urban-toolkit/autk-plot';
import { AutkMap, MapEvent } from '@urban-toolkit/autk-map';
import type { MapEventData } from '@urban-toolkit/autk-map';
import { FeatureCollection } from 'geojson';

function grammarMarkToPlotType(mark: PlotMark): PlotType {
    const mapping: Record<PlotMark, PlotType> = {
        'scatter': 'scatterplot',
        'bar': 'barchart',
        'line': 'linechart',
        'linechart': 'linechart',
        'parallel-coordinates': 'parallel-coordinates',
        'table': 'table',
        'heatmatrix': 'heatmatrix',
    };
    return mapping[mark];
}

/** How a plot is known to links and to `AutkGrammar`: its `id`, else its `dataRef`. */
export function plotKey(spec: PlotSpec): string {
    return spec.id ?? spec.dataRef;
}

/**
 * Links a plot to a layer of a map: picking on the layer selects the features in the plot, and a selection in
 * the plot highlights them on the layer.
 */
export function linkPlotToLayer(plot: AutkPlot, events: AutkPlotEvent[], map: AutkMap, layerId: string): void {
    map.updateRenderInfo(layerId, { isPick: true });

    map.events.on(MapEvent.PICKING, ({ selection }: MapEventData) => {
        plot.setSelection(selection);
    });

    for(const event of events) {
        plot.events.on(event, ({ selection }: PlotEventData) => {
            map.setHighlightedIds(layerId, selection);
        });
    }
}

export function createPlotAdapter(targets?: Targets, registry?: MapRegistry, plotRegistry?: PlotRegistry, plotMapLinks?: PlotMapLinks, cache?: GeoJsonCache, layerIds?: MapLayerIds, computeCache?: ComputeCache): PlotAdapter {

    return {
        async resolvePlot(context: unknown, spec: PlotSpec, index: number = 0): Promise<void> {
            if(!targets || !targets.plot) return;

            // One id holds every plot; a list gives each plot its own, in the order of the plots.
            const target = Array.isArray(targets.plot) ? targets.plot[index] : targets.plot;
            if(target === undefined) throw new Error(`Plot ${index} has no target: the plot targets name ${targets.plot.length} elements.`);

            const div = document.getElementById(target);
            if(!div) throw new Error(`Could not find plot target: ${target}`);

            const db = context as AutkDb | undefined;
            if(!db) throw new Error('No data context available for plot.');

            await enterWorkspace(db, spec.workspace);
            const key = tableKey(spec.workspace, spec.dataRef);
            const geojson: FeatureCollection = computeCache?.get(key) ?? cache?.get(key) ?? await db.getLayer(spec.dataRef);

            const events = (spec.events ?? []) as unknown as AutkPlotEvent[];

            const plot = new AutkPlot(div, {
                type: grammarMarkToPlotType(spec.mark),
                collection: geojson,
                attributes: { axis: spec.axis, ...(spec.color && { color: spec.color }) },
                labels: { axis: spec.axis, title: spec.title },
                events,
                ...(spec.width     && { width: spec.width }),
                ...(spec.height    && { height: spec.height }),
                ...(spec.margins   && { margins: spec.margins }),
                ...(spec.transform && { transform: spec.transform as PlotTransformConfig }),
            });

            plotRegistry?.set(plotKey(spec), plot);
            if (spec.mapRef) plotMapLinks?.set(plotKey(spec), spec.mapRef);

            // mapRef names the table of the layer to link to; the layer's id in its map is its title, else that name.
            if(spec.mapRef && registry) {
                const map: AutkMap | undefined = registry.get(spec.mapRef);
                if(map)
                    linkPlotToLayer(plot, events, map, layerIds?.get(spec.mapRef) ?? spec.mapRef);
            }
        }
    }
}
