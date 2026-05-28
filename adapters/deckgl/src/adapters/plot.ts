import type { FeatureCollection } from 'geojson';
import type { PlotAdapter, PlotSpec } from '@urban-toolkit/the-urban-grammar';
import * as Plot from '@observablehq/plot';
import { DeckGlDb, Targets } from '../types';

type Row = Record<string, unknown>;

function featuresToRows(fc: FeatureCollection): Row[] {
    return fc.features.map(f => f.properties ?? {});
}

function renderTable(container: HTMLElement, rows: Row[], columns: string[]): void {
    const cols = columns.length > 0 ? columns : Object.keys(rows[0] ?? {});

    const table = document.createElement('table');
    table.style.cssText = 'border-collapse:collapse;width:100%;font-size:13px;';

    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    for (const col of cols) {
        const th = document.createElement('th');
        th.textContent = col;
        th.style.cssText = 'padding:4px 8px;border:1px solid #ddd;background:#f5f5f5;text-align:left;';
        headerRow.appendChild(th);
    }

    const tbody = table.createTBody();
    for (const row of rows) {
        const tr = tbody.insertRow();
        for (const col of cols) {
            const td = tr.insertCell();
            td.textContent = String(row[col] ?? '');
            td.style.cssText = 'padding:4px 8px;border:1px solid #ddd;';
        }
    }

    container.appendChild(table);
}

function buildPlotMarks(spec: PlotSpec, rows: Row[]): Plot.Markish[] {
    const [xAxis, yAxis] = spec.axis;
    const colorOpts = spec.color ? { fill: spec.color } : {};
    switch (spec.mark) {
        case 'scatter':
            return [
                Plot.dot(rows, { x: xAxis, y: yAxis, ...colorOpts }),
                Plot.frame(),
            ];

        case 'bar':
            return [
                Plot.barY(rows, Plot.groupX({ y: 'count' }, { x: xAxis, ...colorOpts })),
                Plot.ruleY([0]),
            ];

        case 'line':
        case 'linechart':
            return [
                Plot.line(rows, { x: xAxis, y: yAxis, ...colorOpts }),
                Plot.frame(),
            ];

        case 'heatmatrix':
            return [
                Plot.cell(rows, Plot.group({ fill: 'count' }, { x: xAxis, y: yAxis })),
            ];

        case 'parallel-coordinates':
            // Observable Plot does not have a native parallel coordinates mark.
            // Render each axis as a normalised line series instead.
            return spec.axis.flatMap((col, i) =>
                i < spec.axis.length - 1
                    ? [Plot.line(rows, { x: () => col, y: col, stroke: spec.color ?? 'steelblue', opacity: 0.3 })]
                    : [],
            ).concat([Plot.frame()]);

        case 'table':
            // Handled separately; return empty marks array.
            return [];

        default:
            return [Plot.frame()];
    }
}

export function createPlotAdapter(targets?: Targets, cache?: Map<string, FeatureCollection>): PlotAdapter {
    return {
        async resolvePlot(context: unknown, spec: PlotSpec): Promise<void> {
            if (!targets?.plot) return;

            const div = document.getElementById(targets.plot);
            if (!div) throw new Error(`Plot target not found: ${targets.plot}`);

            const db = context as DeckGlDb | undefined;
            const fc: FeatureCollection | undefined =
                cache?.get(spec.dataRef) ?? db?.get(spec.dataRef);

            if (!fc) throw new Error(`No data found for dataRef: ${spec.dataRef}`);

            const rows = featuresToRows(fc);

            if (spec.mark === 'table') {
                renderTable(div, rows, spec.axis);
                return;
            }

            const marks = buildPlotMarks(spec, rows);
            const margins = spec.margins ?? { top: 20, right: 20, bottom: 40, left: 60 };

            const svg = Plot.plot({
                marks,
                width: spec.width ?? (div.clientWidth || 640),
                height: spec.height ?? 400,
                marginTop: margins.top,
                marginRight: margins.right,
                marginBottom: margins.bottom,
                marginLeft: margins.left,
                ...(spec.title ? { title: spec.title } : {}),
                style: { fontFamily: 'sans-serif' },
            });

            div.appendChild(svg);
        },
    };
}
