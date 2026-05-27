import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            queryArea: {
                geocodeArea: 'Niterói',
                areas: ['Região Praias da Baía'],
            },
            outputTableName: 'table_osm',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads', 'buildings'] as Array<
                    'surface' | 'parks' | 'water' | 'roads' | 'buildings'
                >,
                dropOsmTable: true,
            },
        },
    ],
    map: {
        layerRefs: [
            { dataRef: 'table_osm_surface' },
            { dataRef: 'table_osm_parks' },
            { dataRef: 'table_osm_water' },
            { dataRef: 'table_osm_roads' },
            { dataRef: 'table_osm_buildings' },
        ],
    },
};
