import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            pbfFileUrl: '/data/lower_mnt.osm.pbf',
            queryArea: { bbox: [-74.015, 40.703, -74.006, 40.711] },
            outputTableName: 'fidi',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads'],
            },
        },
        {
            type: 'csv',
            csvFileUrl: '/data/noise_manhattan_clean.csv',
            outputTableName: 'noise',
            geometryColumns: {
                latColumnName: 'latitude',
                longColumnName: 'longitude',
                coordinateFormat: 'EPSG:4326',
            },
        },
    ],
    map: {
        camera: { zoom: 12.6 },
        layerRefs: [
            { dataRef: 'fidi_surface' },
            { dataRef: 'fidi_parks' },
            { dataRef: 'fidi_water' },
            { dataRef: 'fidi_roads' },
            { dataRef: 'noise', title: 'Noise complaints', color: '#d62728', pointSize: 10 },
        ],
    },
};
