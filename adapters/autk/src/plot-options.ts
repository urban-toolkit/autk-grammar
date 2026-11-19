import type { PlotSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMap, ColorMapDomainStrategy, ColorMapInterpolator, valueAtPath } from '@urban-toolkit/autk-core';
import type { ColorMapDomainSpec } from '@urban-toolkit/autk-core';
import type { PlotConfig } from '@urban-toolkit/autk-plot';
import type { Feature } from 'geojson';
import { buildDomainSpec, colorMapRangeRefusal } from './color-keys';

/**
 * What a plot spec sets of autk-plot's config, and what a run refuses of it before any view is drawn. Nothing here needs
 * a page or a GPU, so the unit tests run it in Node.
 */

/** How a plot is known to links and to `AutkGrammar`: its `id`, else its `dataRef`. */
export function plotKey(spec: PlotSpec): string {
    return spec.id ?? spec.dataRef;
}

/** What a plot spec sets of autk-plot's config, beside the plot's type, rows, columns, events and size. */
export type PlotOptions = Pick<PlotConfig, 'labels' | 'colorMapInterpolator' | 'categoricalColorMapInterpolator' | 'domainSpec' | 'tickFormats'>;

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

/** The specifiers d3-format reads: its own pattern, `[[fill]align][sign][symbol][0][width][,][.precision][~][type]`. */
const D3_FORMAT = /^(?:.?[<>=^])?[-+( ]?[$#]?0?\d*,?(?:\.\d+)?~?[a-zA-Z%]?$/;

/**
 * Why a plot refuses its `tickFormats`, or `undefined` when it takes them: autk-plot formats the x axis with the first
 * and the y axis with the second, and d3-format throws on a specifier it cannot read, `undefined` among them.
 */
function tickFormatsRefusal(tickFormats: unknown): string | undefined {
    if (tickFormats === undefined) return undefined;
    if (!Array.isArray(tickFormats) || tickFormats.length !== 2)
        return 'tickFormats must hold two d3-format specifiers, [x, y].';
    const unread = tickFormats.findIndex((format) => typeof format !== 'string' || !D3_FORMAT.test(format));
    if (unread >= 0)
        return `tickFormats[${unread}] ${JSON.stringify(tickFormats[unread])} is not a d3-format specifier, such as "~s", ",d" or ".0%".`;
    return undefined;
}

/**
 * Why a plot refuses its `axisLabels`, or `undefined` when it takes them: titles that are not strings, more titles than
 * `axis` has columns, which a table would show as headers over no cells, and two titles alike, since a table finds the
 * column a click on a header sorts by its title.
 */
function axisLabelsRefusal(axisLabels: unknown, axis: readonly string[]): string | undefined {
    if (axisLabels === undefined) return undefined;
    if (!Array.isArray(axisLabels) || !axisLabels.every((title) => typeof title === 'string'))
        return 'axisLabels must be a list of titles, one for each column of axis.';
    if (axisLabels.length > axis.length)
        return `axisLabels has ${axisLabels.length} titles for the ${axis.length} columns of axis.`;
    const twice = axisLabels.find((title, at) => axisLabels.indexOf(title) !== at);
    if (twice !== undefined)
        return `axisLabels gives two axes the title ${JSON.stringify(twice)}.`;
    return undefined;
}

/** Why a plot refuses its `selection`, or `undefined` when it takes it: positions that are not whole numbers from 0. */
function selectionRefusal(selection: unknown): string | undefined {
    if (selection === undefined) return undefined;
    if (!Array.isArray(selection) || !selection.every((position) => Number.isInteger(position) && position >= 0))
        return 'selection must list the positions of rows, whole numbers from 0.';
    return undefined;
}

/**
 * Refuses what a plot spec sets that autk-plot cannot draw, with a sentence that names the plot. `AutkGrammar.run` calls
 * it for each plot before it draws any view. The schema refuses the same values; a host that skips it gets the sentence.
 */
export function checkPlotKeys(spec: PlotSpec): void {
    const refusal = schemeRefusal('colorMapInterpolator', spec.colorMapInterpolator, false)
        ?? schemeRefusal('categoricalColorMapInterpolator', spec.categoricalColorMapInterpolator, true)
        ?? colorMapRangeRefusal(spec.colorMapRange, spec.colorMapDomain)
        ?? tickFormatsRefusal(spec.tickFormats)
        ?? axisLabelsRefusal(spec.axisLabels, spec.axis)
        ?? selectionRefusal(spec.selection);
    if (refusal) throw new Error(`Plot "${plotKey(spec)}": ${refusal}`);
}

/**
 * Refuses a `selection` that names a row past the plot's last, of the `rowCount` it draws, with a sentence that names
 * the plot. The plot adapter calls it once it has the rows, before it draws the plot. JSON Schema cannot know the rows.
 */
export function checkPlotSelection(spec: PlotSpec, rowCount: number): void {
    const past = spec.selection?.find((position) => position >= rowCount);
    if (past !== undefined)
        throw new Error(`Plot "${plotKey(spec)}": selection names row ${past}, but the plot draws ${rowCount === 1 ? '1 row' : `${rowCount} rows`}.`);
}

/**
 * Whether autk-plot colors a plot's marks by categories: when a value of its `color` column is a string that does not
 * read as a number. A heat matrix's cells, which `@transform` names, hold counts or sums.
 */
function colorsByCategories(color: string | undefined, rows: readonly (Feature | null | undefined)[]): boolean {
    if (color === undefined || color === '@transform') return false;
    return rows.some((row) => {
        const value = valueAtPath(row?.properties ?? {}, color);
        return typeof value === 'string' && isNaN(Number(value));
    });
}

/**
 * How autk-plot finds the domain of the plot's color scale, or `undefined` to leave it autk-plot's, the lowest and
 * highest values. `colorMapRange` sets the ends of a scale of numbers, and a plot colored by categories ignores it, as a
 * layer with a categorical scheme does: autk-core would read the range's two numbers as the only categories. Otherwise
 * a layer's rule applies (`buildDomainSpec`): `colorMapDomain`'s categories, else `normalization`'s percentiles.
 */
function domainSpecOf(spec: PlotSpec, rows: readonly (Feature | null | undefined)[]): ColorMapDomainSpec | undefined {
    const range = spec.colorMapRange;
    if (range !== undefined && !colorsByCategories(spec.color, rows))
        return { type: ColorMapDomainStrategy.USER, params: [range[0], range[1]] };
    if (spec.normalization === undefined && spec.colorMapDomain === undefined) return undefined;
    return buildDomainSpec(spec.normalization, spec.colorMapDomain);
}

/**
 * The title of each axis: its `axisLabels` entry, else its column's name, and `value`, autk-plot's own title, for the
 * axis that holds a transform's output, `@transform`. autk-plot titles the axes by the list it is handed, a table's
 * headers too, so the list holds a title for every column.
 */
function axisTitles(spec: PlotSpec): string[] {
    return spec.axis.map((column, at) => spec.axisLabels?.[at] ?? (column === '@transform' ? 'value' : column));
}

/**
 * The part of autk-plot's config a plot spec sets, beside its type, rows, columns, events and size. `rows` are the
 * features the plot draws.
 */
export function plotOptions(spec: PlotSpec, rows: readonly (Feature | null | undefined)[]): PlotOptions {
    const domainSpec = domainSpecOf(spec, rows);
    return {
        labels: { axis: axisTitles(spec), title: spec.title },
        // The grammar's scheme names are autk-core's, as strings.
        ...(spec.colorMapInterpolator !== undefined && { colorMapInterpolator: spec.colorMapInterpolator as unknown as ColorMapInterpolator }),
        ...(spec.categoricalColorMapInterpolator !== undefined && {
            categoricalColorMapInterpolator: spec.categoricalColorMapInterpolator as unknown as ColorMapInterpolator,
        }),
        ...(domainSpec && { domainSpec }),
        ...(spec.tickFormats !== undefined && { tickFormats: [...spec.tickFormats] }),
    };
}
