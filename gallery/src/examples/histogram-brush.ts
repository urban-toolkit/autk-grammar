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
        layerRefs: [{ dataRef: 'neighborhoods' }],
    },
    plot: {
        dataRef: 'neighborhoods',
        mark: 'bar',
        axis: ['shape_area', '@transform'],
        title: 'Histogram example',
        transform: { preset: 'binning-1d', options: { bins: 10 } },
        margins: { left: 60, right: 20, top: 50, bottom: 80 },
        width: 790,
        events: ['brushX'],
        mapRef: 'neighborhoods',
    },
};
