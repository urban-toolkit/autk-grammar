import type { PlotSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMap, ColorMapInterpolator } from '@urban-toolkit/autk-core';
import type { PlotConfig } from '@urban-toolkit/autk-plot';

/**
 * What a plot spec sets of autk-plot's config, and what a run refuses of it before any view is drawn. Nothing here needs
 * a page or a GPU, so the unit tests run it in Node.
 */

/** How a plot is known to links and to `AutkGrammar`: its `id`, else its `dataRef`. */
export function plotKey(spec: PlotSpec): string {
    return spec.id ?? spec.dataRef;
}

/** What a plot spec sets of autk-plot's config, beside the plot's type, rows, columns, events and size. */
export type PlotOptions = Pick<PlotConfig, 'labels' | 'colorMapInterpolator' | 'categoricalColorMapInterpolator'>;

const SCHEMES = new Set<string>(Object.values(ColorMapInterpolator));

/**
 * Why a plot refuses the scheme `key` names, or `undefined` when it takes it. `categorical` says which kind the key
 * takes: autk-plot colors numbers by `colorMapInterpolator` and categories by `categoricalColorMapInterpolator`, and a
 * scheme of the other kind would color numbers as categories in the other key's scheme.
 */
function schemeRefusal(key: 'colorMapInterpolator' | 'categoricalColorMapInterpolator', scheme: unknown, categorical: boolean): string | undefined {
    if (scheme === undefined) return undefined;
    if (typeof scheme !== 'string' || !SCHEMES.has(scheme)) return `${key} ${JSON.stringify(scheme)} is not a color scheme.`;
    if (ColorMap.isCategorical(scheme as ColorMapInterpolator) === categorical) return undefined;
    return categorical
        ? `${key} "${scheme}" is not a categorical scheme: categories take a scheme* scheme, such as schemeTableau10.`
        : `${key} "${scheme}" is a categorical scheme: numbers take an interpolate* scheme, and categories take categoricalColorMapInterpolator.`;
}

/**
 * Refuses what a plot spec sets that autk-plot cannot draw, with a sentence that names the plot. `AutkGrammar.run` calls
 * it for each plot before it draws any view. The schema refuses the same values; a host that skips it gets the sentence.
 */
export function checkPlotKeys(spec: PlotSpec): void {
    const refusal = schemeRefusal('colorMapInterpolator', spec.colorMapInterpolator, false)
        ?? schemeRefusal('categoricalColorMapInterpolator', spec.categoricalColorMapInterpolator, true);
    if (refusal) throw new Error(`Plot "${plotKey(spec)}": ${refusal}`);
}

/** The part of autk-plot's config a plot spec sets, beside its type, rows, columns, events and size. */
export function plotOptions(spec: PlotSpec): PlotOptions {
    return {
        labels: { axis: spec.axis, title: spec.title },
        // The grammar's scheme names are autk-core's, as strings.
        ...(spec.colorMapInterpolator !== undefined && { colorMapInterpolator: spec.colorMapInterpolator as unknown as ColorMapInterpolator }),
        ...(spec.categoricalColorMapInterpolator !== undefined && {
            categoricalColorMapInterpolator: spec.categoricalColorMapInterpolator as unknown as ColorMapInterpolator,
        }),
    };
}
