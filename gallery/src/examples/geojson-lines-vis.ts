import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_roads.geojson',
            outputTableName: 'roads',
            coordinateFormat: 'EPSG:4326',
        },
    ],
    map: {
        layerRefs: [{ dataRef: 'roads', opacity: 0.75 }],
    },
};
