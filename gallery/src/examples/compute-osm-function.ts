import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            queryArea: {
                geocodeArea: 'New York',
                areas: ['Battery Park City', 'Financial District'],
            },
            outputTableName: 'table_osm',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads'] as Array<
                    'surface' | 'parks' | 'water' | 'roads' | 'buildings'
                >,
                dropOsmTable: true,
            },
        },
    ],
    compute: [
        {
            dataRef: 'table_osm_roads',
            attributes: { x: 'lanes' },
            outputColumnName: 'result',
            wgslFunction: `
                if (x <= 0) {
                    return 1;
                }
                return x;
            `,
        },
    ],
    map: {
        // Battery Park City and the Financial District, about 2.3 by 2.8 km, fill most of the view.
        camera: { zoom: 11.2 },
        layerRefs: [
            { dataRef: 'table_osm_surface' },
            { dataRef: 'table_osm_parks' },
            { dataRef: 'table_osm_water' },
            {
                dataRef: 'table_osm_roads',
                getFnv: 'compute.result',
                getFnvType: 'quantitative',
                defaultFnv: 0,
            },
        ],
    },
};
