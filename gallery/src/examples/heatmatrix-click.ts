import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs_proj_landuse.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:3395',
        },
    ],
    map: {
        layerRefs: [{ dataRef: 'neighborhoods', isPick: true }],
    },
    plot: {
        dataRef: 'neighborhoods',
        mark: 'heatmatrix',
        axis: ['shape_area', 'landuse'],
        color: '@transform',
        title: 'Neighborhoods by Area and Land Use',
        width: 790,
        margins: { left: 100, right: 20, top: 50, bottom: 80 },
        transform: { preset: 'binning-2d', options: { binsX: 5 } },
        events: ['click'],
        mapRef: 'neighborhoods',
    },
};
