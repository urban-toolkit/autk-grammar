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
        mark: 'bar',
        axis: ['ntaname', 'shape_area'],
        title: 'Barchart example',
        width: 790,
        margins: { left: 60, right: 20, top: 50, bottom: 200 },
        events: ['click'],
        mapRef: 'neighborhoods',
    },
};
