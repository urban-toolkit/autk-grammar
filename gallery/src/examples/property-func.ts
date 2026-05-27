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
                layers: ['buildings'] as Array<'surface' | 'parks' | 'water' | 'roads' | 'buildings'>,
                dropOsmTable: true,
            },
        },
    ],
    compute: [
        {
            dataRef: 'table_osm_buildings',
            attributes: { x: 'height', y: 'height' },
            outputColumnName: 'height_sq',
            wglsFunction: 'return x * y;',
        },
    ],
};
