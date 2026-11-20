import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

// The Financial District in a style of the spec's own: each type of layer in a color of a night palette, and the map
// without its floating menu and legend.
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
        style: {
            background: '#0b1a2a',
            surface: '#13263a',
            parks: '#1f4d3a',
            water: '#08121d',
            roads: '#4a6584',
            buildings: '#c9a96e',
            points: '#f2c14e',
            polylines: '#7f97ad',
            polygons: '#2a3d52',
        },
        showUi: false,
        camera: { zoom: 13, pitch: 45, bearing: 30 },
        layerRefs: [
            { dataRef: 'fidi_surface' },
            { dataRef: 'fidi_parks' },
            { dataRef: 'fidi_water' },
            { dataRef: 'fidi_roads' },
            { dataRef: 'fidi_buildings' },
        ],
    },
};
