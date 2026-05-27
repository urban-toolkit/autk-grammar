import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            queryArea: { geocodeArea: 'New York', areas: ['Manhattan Island'] },
            outputTableName: 'table_osm',
            autoLoadLayers: {
                layers: ['parks', 'water'] as Array<'surface' | 'parks' | 'water' | 'roads' | 'buildings'>,
                dropOsmTable: true,
            },
        },
    ],
    map: {
        layerRefs: [
            { dataRef: 'table_osm_water' },
            { dataRef: 'table_osm_parks' },
        ],
    },
};
