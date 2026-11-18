import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            pbfFileUrl: '/data/lower_mnt.osm.pbf',
            queryArea: { bbox: [-74.0195, 40.7, -74.0085, 40.7085] },
            outputTableName: 'tip',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads'],
            },
        },
        {
            type: 'heatmap',
            joinDataRef: 'tip_parks',
            near: { distance: 200, useCentroid: false },
            outputTableName: 'park_access',
            grid: { rows: 30, columns: 30 },
            groupBy: [{ column: '*', aggregateFn: 'count' }],
        },
    ],
    map: {
        camera: { zoom: 12.6 },
        layerRefs: [
            { dataRef: 'tip_surface' },
            { dataRef: 'tip_parks' },
            { dataRef: 'tip_water' },
            { dataRef: 'tip_roads' },
            { dataRef: 'park_access', title: 'Parks within about 150 m', getFnv: 'count.tip_parks', opacity: 0.6 },
        ],
    },
};
