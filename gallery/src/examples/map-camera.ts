import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            pbfFileUrl: '/data/lower_mnt.osm.pbf',
            queryArea: { bbox: [-74.015, 40.703, -74.006, 40.711] },
            outputTableName: 'fidi',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads', 'buildings'],
            },
        },
    ],
    map: {
        camera: { zoom: 13, pitch: 55, bearing: 30 },
        layerRefs: [
            { dataRef: 'fidi_surface' },
            { dataRef: 'fidi_parks' },
            { dataRef: 'fidi_water' },
            { dataRef: 'fidi_roads' },
            { dataRef: 'fidi_buildings' },
        ],
    },
};
