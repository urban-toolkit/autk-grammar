import { arrangeViews } from '@urban-toolkit/the-urban-grammar';
import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

/** The panes of a spec's views, and the grammar's targets, which name the element each view draws in. */
export type Panes = {
    /** The element that holds the panes: a grid of the arrangement's rows and columns. */
    element: HTMLElement;
    /** One id for a single map or plot, a list of ids, one per view in the spec's order, for several. */
    targets: { map?: string | string[]; plot?: string | string[] };
};

/**
 * Builds a pane for each view of `spec`, placed as `arrangeViews` says, as every host arranges a spec's views: a grid of
 * its rows and columns, `gap` pixels apart. A map draws on a canvas (`mapTag` `canvas`, for the Autark adapter) or in
 * a div (deck.gl) that fills its pane; the pane is positioned, so the controls autk-map adds to the map's parent stay
 * on that map. A plot draws in a div that scrolls when the plot is larger than its pane. Each element's id is `idPrefix`
 * and the view's kind and index, such as `map-0`, and a pane of a view with an `id` holds it in `data-view-id`.
 *
 * Its styles are its own, so the panes need no stylesheet; the element is a flex item that fills the rest of its parent.
 */
export function createPanes(spec: UrbanSpec, mapTag: 'canvas' | 'div', idPrefix = ''): Panes {
    const { rows, columns, gap, panes } = arrangeViews(spec);
    const element = document.createElement('div');
    element.className = 'views';
    Object.assign(element.style, {
        flex: '1',
        minHeight: '0',
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${Math.max(rows, 1)}, minmax(0, 1fr))`,
        gap: `${gap}px`,
    });

    const ids: { map: string[]; plot: string[] } = { map: [], plot: [] };
    for (const pane of panes) {
        const slot = document.createElement('div');
        slot.className = `view-pane ${pane.kind}-pane`;
        if (pane.id !== undefined) slot.dataset.viewId = pane.id;
        Object.assign(slot.style, {
            position: 'relative',
            overflow: 'hidden',
            minWidth: '0',
            minHeight: '0',
            gridRow: String(pane.row + 1),
            gridColumn: String(pane.column + 1),
        });

        const id = `${idPrefix}${pane.kind}-${pane.index}`;
        const target = document.createElement(pane.kind === 'map' ? mapTag : 'div');
        target.id = id;
        target.className = pane.kind === 'map' ? 'map-el' : 'plot-body';
        Object.assign(target.style, { display: 'block', width: '100%', height: '100%', boxSizing: 'border-box' });
        if (pane.kind === 'plot') target.style.overflow = 'auto';
        slot.appendChild(target);
        element.appendChild(slot);
        ids[pane.kind][pane.index] = id;
    }

    const targets: Panes['targets'] = {};
    if (ids.map.length > 0) targets.map = ids.map.length === 1 ? ids.map[0] : ids.map;
    if (ids.plot.length > 0) targets.plot = ids.plot.length === 1 ? ids.plot[0] : ids.plot;
    return { element, targets };
}
