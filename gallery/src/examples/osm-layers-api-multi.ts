import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            queryArea: {
                geocodeArea: 'New York',
                areas: ['Battery Park City'],
            },
            outputTableName: 'table_osm_battery',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads', 'buildings'] as Array<
                    'surface' | 'parks' | 'water' | 'roads' | 'buildings'
                >,
                dropOsmTable: true,
            },
        },
        {
            type: 'osm',
            queryArea: {
                geocodeArea: 'New York',
                areas: ['Financial District'],
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
    map: [
        {
            layerRefs: [
                { dataRef: 'table_osm_battery_surface' },
                { dataRef: 'table_osm_battery_parks' },
                { dataRef: 'table_osm_battery_water' },
                { dataRef: 'table_osm_battery_roads' },
                { dataRef: 'table_osm_battery_buildings' },
            ],
        },
        {
            layerRefs: [
                { dataRef: 'table_osm_surface' },
                { dataRef: 'table_osm_parks' },
                { dataRef: 'table_osm_water' },
                { dataRef: 'table_osm_roads' },
                { dataRef: 'table_osm_buildings' },
            ],
        },
    ],
};
