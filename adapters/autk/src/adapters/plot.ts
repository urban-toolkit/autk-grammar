import { PlotAdapter, PlotSpec, PlotMark } from '@urban-toolkit/the-urban-grammar';
import { enterWorkspace, tableKey } from '../workspace';
import { Targets, PlotRegistry, GeoJsonCache, ComputeCache } from '../types';
import { addPlotLink, checkLinkedRows, exportKey, exportOf, exportOptions, osmElementsOf } from '../drawn';
import type { DrawnLayer, DrawnLayers, LayerExports, PlotCollections, PlotLinks, PlotRows } from '../drawn';
import { rowKeys, translateIds } from '../rows';
import { checkPlotSelection, plotKey, plotOptions } from '../plot-options';
import type { PlotColors } from '../plot-options';
import { AutkDb, isRenderableTable } from '@urban-toolkit/autk-db';
import { AutkPlot, PlotEvent as AutkPlotEvent, PlotStyle } from '@urban-toolkit/autk-plot';
import type { PlotEventData, PlotType, PlotTransformConfig } from '@urban-toolkit/autk-plot';
import type { ColorHEX } from '@urban-toolkit/autk-core';
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

/** autk-plot's colors before a run set its own, which a run whose spec sets neither gives back. */
let colorsBefore: { markColor: ColorHEX; highlightColor: ColorHEX } | undefined;

/**
 * Sets the page's plot colors for a run that draws plots. autk-plot keeps one mark color and one highlight color for the
 * whole page (`PlotStyle`), which every plot reads as it draws and as it shows a selection. So a run that sets them
 * colors every plot on the page, and a run whose plots set neither gives back the colors autk-plot had before a run set
 * any: a run draws in the colors its own spec gives, though a host makes a new grammar for each run and never destroys
 * the old one. A page whose specs set neither never has its colors touched. The plot adapter calls it just before it
 * draws each plot of a run, and `AutkGrammar.run` just before the run's plots show their first selections: so a run that
 * draws no plot, or fails before it draws one, leaves the colors as they are, and the plots of a run that loads its data
 * while another run draws its own are drawn in their run's colors.
 */
export function setPlotColors(colors: PlotColors): void {
    if (colors.markColor === undefined && colors.highlightColor === undefined && !colorsBefore) return;
    colorsBefore ??= { markColor: PlotStyle.default, highlightColor: PlotStyle.highlight };
    PlotStyle.setDefaultColor((colors.markColor ?? colorsBefore.markColor) as ColorHEX);
    PlotStyle.setHighlightColor((colors.highlightColor ?? colorsBefore.highlightColor) as ColorHEX);
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
 * A table's rows as a plot reads them from autk-db: the export of a table with a geometry, the one the maps of the run
 * draw, one feature per OpenStreetMap element with `osmElements`, and for a table without one, such as a CSV or JSON
 * table loaded without `geometryColumns`, which autk-db does not export as a layer, its rows, each a feature without a
 * geometry. autk-plot reads only the features' properties.
 */
async function tableRows(db: AutkDb, name: string, key: string, exports?: LayerExports, osmElements?: boolean): Promise<FeatureCollection> {
    const table = db.getTablesMetadata().find((candidate) => candidate.name === name);
    if (table && !isRenderableTable(table)) {
        const rows = await db.getTable(name);
        // A feature without a geometry, which GeoJSON allows and the plot does not read.
        return { type: 'FeatureCollection', features: rows.map((properties) => ({ type: 'Feature', geometry: null, properties })) } as unknown as FeatureCollection;
    }
    return exportOf(exports, exportKey(key, osmElements), () => db.getLayer(name, exportOptions(osmElements)));
}

/**
 * The plot adapter `AutkGrammar` runs. Each plot it draws goes in `plotRegistry`, the keys of the rows it draws in
 * `plotRows`, and the collection it handed autk-plot in `plotCollections`, by the plot's `id`, else its `dataRef`. A table
 * it reads from autk-db is the export the maps of the run draw, from `exports`. `colors` gives the page's plot colors the
 * run's spec sets, which it sets just before it draws each plot (see {@link setPlotColors}).
 */
export function createPlotAdapter(targets?: Targets, layers?: DrawnLayers, plotRegistry?: PlotRegistry, plotLinks?: PlotLinks, cache?: GeoJsonCache, computeCache?: ComputeCache, plotRows?: PlotRows, exports?: LayerExports, plotCollections?: PlotCollections, colors?: () => PlotColors): PlotAdapter {

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
            // The rows of a GeoJSON source or a join are a row per feature, so a plot of OSM elements reads autk-db's. So
            // does a plot of the elements of a table a pass changed in place, which the pass leaves as they were.
            const elements = spec.osmElements === true && computeCache?.has(key) ? await osmElementsOf(db, spec.dataRef, key, exports) : undefined;
            const cached = spec.osmElements === true ? undefined : cache?.get(key);
            const geojson: FeatureCollection = elements ?? computeCache?.get(key) ?? cached ?? await tableRows(db, spec.dataRef, key, exports, spec.osmElements);
            // Refused before the plot is made, so a refused selection leaves no plot on the page.
            checkPlotSelection(spec, geojson.features?.length ?? 0);
            // mapRef names the table of the layers to link to: every layer that draws it, in every map. The maps are
            // drawn before the plots. A layer that reads its table otherwise than the plot, by OSM elements or by rows,
            // is refused before the plot is made too (checkLinkedRows).
            const linked = spec.mapRef ? (layers ?? []).filter((layer) => layer.dataRef === spec.mapRef) : [];
            for(const layer of linked) checkLinkedRows(plotKey(spec), geojson, layer, 'by its mapRef');

            const events = (spec.events ?? []) as unknown as AutkPlotEvent[];

            // autk-plot draws the plot as it makes it, in the page's colors: the run's, set here, after every wait of
            // the run, since another run may have set its own meanwhile.
            if (colors) setPlotColors(colors());
            const plot = new AutkPlot(div, {
                type: grammarMarkToPlotType(spec.mark),
                collection: geojson,
                attributes: { axis: spec.axis, ...(spec.color && { color: spec.color }) },
                events,
                ...plotOptions(spec, geojson.features ?? []),
                ...(spec.width     && { width: spec.width }),
                ...(spec.height    && { height: spec.height }),
                ...(spec.margins   && { margins: spec.margins }),
                ...(spec.transform && { transform: spec.transform as PlotTransformConfig }),
            });
            // autk-plot's scatter plot draws every point in its mark color, and colors the points by `color` only when it
            // styles them for a selection: style them once, with nothing selected.
            if(spec.mark === 'scatter' && spec.color !== undefined)
                plot.setSelection([]);

            plotRegistry?.set(plotKey(spec), plot);
            plotCollections?.set(plotKey(spec), geojson);
            // autk-plot names a row by its position in the collection it draws.
            const rows = rowKeys(geojson.features ?? []);
            plotRows?.set(plotKey(spec), rows);

            for(const layer of linked) {
                linkPlotToLayer(plot, rows, events, layer);
                addPlotLink(plotLinks, plotKey(spec), layer);
            }
        }
    }
}
