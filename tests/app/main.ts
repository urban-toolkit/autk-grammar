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
        runExample: (name: string) => Promise<RunSummary>;
        valueAt: (table: string, index: number, path: string) => Promise<unknown>;
    }
}

/** Runs a gallery example spec, creating a canvas per map and a div for the plot. */
window.runExample = async (name: string) => {
    const load = examples[`../../gallery/src/examples/${name}.ts`];
    if (!load) throw new Error(`No gallery example named ${name}`);
    const { spec } = await load();

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
