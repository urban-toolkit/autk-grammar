import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:4326',
        },
        {
            type: 'csv',
            outputTableName: 'noise',
            csvFileUrl: '/data/noise.csv',
            geometryColumns: {
                latColumnName: 'Latitude',
                longColumnName: 'Longitude',
                coordinateFormat: 'EPSG:4326',
            },
        },
    ],
    compute: [
        {
            dataRef: 'neighborhoods',
            attributes: {
                x: 'shape_area',
                y: 'shape_leng',
            },
            outputColumnName: 'result',
            wglsFunction: 'return (4.0 * 3.1415927 * x) / (y * y);',
        },
    ],
    map: {
        style: 'light',
        layerRefs: [
            {
                dataRef: 'neighborhoods',
                getFnv: 'compute.result',
                getFnvType: 'quantitative',
                defaultFnv: 0,
            },
        ],
    },
};
