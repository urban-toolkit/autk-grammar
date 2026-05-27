import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs_proj.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:3395',
        },
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_pois_proj.geojson',
            outputTableName: 'points',
            coordinateFormat: 'EPSG:3395',
        },
    ],
    map: {
        layerRefs: [
            { dataRef: 'neighborhoods' },
            { dataRef: 'points' },
        ],
    },
};
