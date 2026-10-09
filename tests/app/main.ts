import { AutkGrammar } from '@urban-toolkit/autk-grammar';
import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export type TableSummary = { features: number; properties: string[] };
export type RunSummary = { tables: Record<string, TableSummary>; plotSvgs: number };

const examples = import.meta.glob<{ spec: UrbanSpec }>('../../gallery/src/examples/*.ts');

function element(tag: 'canvas' | 'div', id: string): HTMLElement {
    const el = document.createElement(tag);
    el.id = id;
    document.getElementById('stage')!.appendChild(el);
    return el;
}

declare global {
    interface Window {
        grammar: AutkGrammar;
        runSpec: (spec: UrbanSpec) => Promise<RunSummary>;
        runExample: (name: string) => Promise<RunSummary>;
        valueAt: (table: string, index: number, path: string) => Promise<unknown>;
        readMap: (canvasId: string) => Promise<string>;
    }
}

/** Runs a gallery example spec. */
window.runExample = async (name: string) => {
    const load = examples[`../../gallery/src/examples/${name}.ts`];
    if (!load) throw new Error(`No gallery example named ${name}`);
    const { spec } = await load();
    return window.runSpec(spec);
};

/** Runs a spec, creating a canvas per map and a div for the plot. */
window.runSpec = async (spec: UrbanSpec) => {
    document.getElementById('stage')!.innerHTML = '';
    const maps = Array.isArray(spec.map) ? spec.map.map((_, i) => `map${i}`) : spec.map ? ['map0'] : [];
    maps.forEach((id) => element('canvas', id));
    if (spec.plot) element('div', 'plot');

    const grammar = new AutkGrammar({
        ...(maps.length && { map: Array.isArray(spec.map) ? maps : maps[0] }),
        ...(spec.plot && { plot: 'plot' }),
    });
    window.grammar = grammar;
    await grammar.run(spec);

    const tables: Record<string, TableSummary> = {};
    for (const table of Object.keys(grammar.data)) {
        const collection = await grammar.data[table];
        tables[table] = {
            features: collection.features.length,
            properties: Object.keys(collection.features[0]?.properties ?? {}),
        };
    }
    return { tables, plotSvgs: document.querySelectorAll('#plot svg').length };
};

/** Reads a (dot path) property of one feature, e.g. valueAt('neighborhoods', 0, 'sjoin.count.noise'). */
window.valueAt = async (table: string, index: number, path: string) => {
    const collection = await window.grammar.data[table];
    return path.split('.').reduce<unknown>(
        (value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]),
        collection.features[index]?.properties,
    );
};

/**
 * Reads a map canvas as a PNG data URL, in the animation frame that draws the map.
 *
 * A map draws on demand, and Chrome can read an idle WebGPU canvas back as transparent. So this
 * asks the map for one frame and reads the canvas in an animation frame callback registered after
 * the map's own, which runs in the same frame, before the frame is shown. requestRender() does
 * nothing for a map whose draw() never ran, so such a map reads back blank.
 */
window.readMap = (canvasId: string) => {
    const map = window.grammar.maps.find((m) => m.canvas.id === canvasId);
    if (!map) throw new Error(`No map draws on #${canvasId}`);
    map.requestRender();
    return new Promise<string>((resolve) => requestAnimationFrame(() => resolve(map.canvas.toDataURL('image/png'))));
};
