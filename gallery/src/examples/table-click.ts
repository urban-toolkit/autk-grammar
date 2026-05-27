import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs_proj.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:3395',
        },
    ],
    map: {
        layerRefs: [{ dataRef: 'neighborhoods', isPick: true }],
    },
    plot: {
        dataRef: 'neighborhoods',
        mark: 'table',
        axis: ['ntaname', 'shape_area', 'shape_leng'],
        title: 'Table Visualization',
        width: 790,
        transform: { preset: 'sort', options: { direction: 'asc' } },
        events: ['click'],
        mapRef: 'neighborhoods',
    },
};
