import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

// A tour of the Financial District around the New York Stock Exchange: in closer, tilted toward the horizon while the
// view moves north, then turned a quarter clockwise to face east.
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
        camera: {
            center: [-74.011, 40.7069],
            zoom: 13,
            motion: [
                { type: 'zoom', amount: 1.5, seconds: 2 },
                { type: 'pitch', amount: 55, seconds: 2.5, pan: 150 },
                { type: 'bearing', amount: 90, seconds: 4 },
            ],
        },
        layerRefs: [
            { dataRef: 'fidi_surface' },
            { dataRef: 'fidi_parks' },
            { dataRef: 'fidi_water' },
            { dataRef: 'fidi_roads' },
            { dataRef: 'fidi_buildings' },
        ],
    },
};
