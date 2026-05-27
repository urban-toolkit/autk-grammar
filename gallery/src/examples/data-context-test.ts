import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkGrammar } from '@urban-toolkit/autk-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:4326',
        },
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_pois_proj.geojson',
            outputTableName: 'landmarks',
            coordinateFormat: 'EPSG:3395',
        },
    ],
    compute: [
        {
            dataRef: 'neighborhoods',
            attributes: { x: 'shape_area', y: 'shape_leng' },
            outputColumnName: 'compactness',
            wglsFunction: 'return (4.0 * 3.1415927 * x) / (y * y);',
        },
    ],
};

export async function afterRun(grammar: unknown) {
    const g = grammar as AutkGrammar;
    const out = document.getElementById('debug-output')!;

    out.innerHTML += `<hr>`;

    // Show what keys exist without fetching anything
    const tableNames = Object.keys(g.data);
    out.innerHTML += `<p><strong>grammar.data keys (no fetch yet):</strong> ${JSON.stringify(tableNames)}</p>`;

    // Demonstrate lazy evaluation: log before and after the await
    out.innerHTML += `<p>Accessing <code>grammar.data['neighborhoods']</code>...</p>`;
    console.log('[data-context-test] getLayer call starting (lazy)');
    const fc = await g.data['neighborhoods'];
    console.log('[data-context-test] getLayer resolved:', fc);

    out.innerHTML += `<p><strong>Features returned:</strong> ${fc.features.length}</p>`;
    out.innerHTML += `<p><strong>First feature properties:</strong></p>`;
    out.innerHTML += `<pre>${JSON.stringify(fc.features[0]?.properties, null, 2)}</pre>`;
}
