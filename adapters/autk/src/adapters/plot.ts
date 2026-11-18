import { PlotAdapter, PlotSpec, PlotMark } from '@urban-toolkit/the-urban-grammar';
import { enterWorkspace, tableKey } from '../workspace';
import { Targets, PlotRegistry, GeoJsonCache, ComputeCache } from '../types';
import { addPlotLink, exportOf } from '../drawn';
import type { DrawnLayer, DrawnLayers, LayerExports, PlotLinks, PlotRows } from '../drawn';
import { rowKeys, translateIds } from '../rows';
import { AutkDb } from '@urban-toolkit/autk-db';
import { AutkPlot, PlotEvent as AutkPlotEvent } from '@urban-toolkit/autk-plot';
import type { PlotEventData, PlotType, PlotTransformConfig } from '@urban-toolkit/autk-plot';
import { MapEvent } from '@urban-toolkit/autk-map';
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
 * the plot highlights them on the layer. `rows` holds the key of the row the plot draws at each position: a selection
 * passes between the two by the rows each drew (see `translateIds`), since one position can be another row in each.
 */
export function linkPlotToLayer(plot: AutkPlot, rows: readonly string[], events: AutkPlotEvent[], layer: DrawnLayer): void {
    const { map, layerId } = layer;
    map.updateRenderInfo(layerId, { isPick: true });

    // A pick names the layer it was made on, so a pick on another layer of the map leaves the plot alone.
    map.events.on(MapEvent.PICKING, ({ layerId: picked, selection }: MapEventData) => {
        if (picked === layerId) plot.setSelection(translateIds(selection, layer.rows, rows));
    });

    for(const event of events) {
        plot.events.on(event, ({ selection }: PlotEventData) => {
            map.setHighlightedIds(layerId, translateIds(selection, rows, layer.rows));
        });
    }
}

/**
 * The plot adapter `AutkGrammar` runs. Each plot it draws goes in `plotRegistry`, and the keys of the rows it draws in
 * `plotRows`, by the plot's `id`, else its `dataRef`. A table it reads from autk-db is the export the maps of the run
 * draw, from `exports`.
 */
export function createPlotAdapter(targets?: Targets, layers?: DrawnLayers, plotRegistry?: PlotRegistry, plotLinks?: PlotLinks, cache?: GeoJsonCache, computeCache?: ComputeCache, plotRows?: PlotRows, exports?: LayerExports): PlotAdapter {

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
            const geojson: FeatureCollection = computeCache?.get(key) ?? cache?.get(key) ?? await exportOf(exports, key, () => db.getLayer(spec.dataRef));

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
            // autk-plot names a row by its position in the collection it draws.
            const rows = rowKeys(geojson.features ?? []);
            plotRows?.set(plotKey(spec), rows);

            // mapRef names the table of the layers to link to: every layer that draws it, in every map. The maps are
            // drawn before the plots.
            for(const layer of layers ?? []) {
                if(!spec.mapRef || layer.dataRef !== spec.mapRef) continue;
                linkPlotToLayer(plot, rows, events, layer);
                addPlotLink(plotLinks, plotKey(spec), layer);
            }
        }
    }
}
