import type { UrbanSpec } from './types';

/** A view's pane, as {@link arrangeViews} places it. */
export type ViewPane = {
    /** `map` or `plot`. It is also the key of the adapter's targets whose list names the element the view draws in. */
    kind: 'map' | 'plot',
    /**
     * The view's position among the views of its kind, in the spec's order: its element is entry `index` of the `map`
     * or `plot` target list.
     */
    index: number,
    /** The view's `id`, when it has one. */
    id?: string,
    /**
     * The name the grammar knows the view by: its `id`, else a map's `index` or a plot's `dataRef`. A map's is the
     * `mapId` of its `map:picking` events, and a plot's the `plotId` of its `plot:selection` events; the calls that
     * address one map or plot take it.
     */
    key: string | number,
    /** The pane's row in the arrangement, from 0 at the top. */
    row: number,
    /** The pane's column in the arrangement, from 0 at the left. */
    column: number,
}

/** How the views of a spec are arranged on the page: a grid of `rows` by `columns` panes, `gap` pixels apart. */
export type ViewArrangement = {
    /**
     * `vertical` stacks the panes, `horizontal` puts them side by side, and `grid` fills `columns` columns, row by row:
     * the spec's `layout.type`, else `vertical`.
     */
    type: 'vertical' | 'horizontal' | 'grid',
    /** The rows of panes. */
    rows: number,
    /** The columns of panes: 1 when `vertical`, one per view when `horizontal`, and `layout.columns`, else 2, for a `grid`. */
    columns: number,
    /** The space between neighboring panes, in pixels: the spec's `layout.gap`, else 0. */
    gap: number,
    /**
     * One pane per view, in the order the grammar draws them: the maps in the order of `map`, then the plots in the
     * order of `plot`.
     */
    panes: ViewPane[],
}

function asList<T>(value: T[] | T | undefined): T[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * Where each view of a spec goes on the page, as its `layout` says, so every host arranges a spec's views alike. The
 * host makes an element for each pane (a canvas for an Autark map), places it at the pane's row and column of a grid
 * of `rows` by `columns`, `gap` pixels apart, and names it in the adapter's targets: entry `index` of the `map` or
 * `plot` list. Without a `layout`, the panes stack.
 *
 * A layout whose `type`, `columns` or `gap` cannot be arranged is refused, with a sentence that names the value.
 *
 * @example
 * const { columns, gap, panes } = arrangeViews(spec);
 * for (const pane of panes) {
 *     const element = document.createElement(pane.kind === 'map' ? 'canvas' : 'div');
 *     element.style.gridRow = String(pane.row + 1);
 *     element.style.gridColumn = String(pane.column + 1);
 * }
 */
export function arrangeViews(spec: UrbanSpec): ViewArrangement {
    const layout = spec.layout ?? {};
    const type = layout.type ?? 'vertical';
    if (type !== 'vertical' && type !== 'horizontal' && type !== 'grid')
        throw new Error(`Layout type must be vertical, horizontal or grid, not ${JSON.stringify(type)}.`);
    const gap = layout.gap ?? 0;
    if (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0)
        throw new Error(`Layout gap must be a number of pixels, 0 or more, not ${JSON.stringify(gap)}.`);
    const gridColumns = layout.columns ?? 2;
    if (!Number.isInteger(gridColumns) || gridColumns < 1)
        throw new Error(`Layout columns must be a whole number, 1 or more, not ${JSON.stringify(gridColumns)}.`);

    const views = [
        ...asList(spec.map).map((map, index) => ({ kind: 'map' as const, index, id: map.id, key: map.id ?? index })),
        ...asList(spec.plot).map((plot, index) => ({ kind: 'plot' as const, index, id: plot.id, key: plot.id ?? plot.dataRef })),
    ];
    const columns = type === 'vertical' ? 1 : type === 'horizontal' ? Math.max(views.length, 1) : gridColumns;
    const panes = views.map(({ kind, index, id, key }, at): ViewPane => ({
        kind,
        index,
        ...(id !== undefined && { id }),
        key,
        row: Math.floor(at / columns),
        column: at % columns,
    }));
    return { type, rows: Math.ceil(views.length / columns), columns, gap, panes };
}
