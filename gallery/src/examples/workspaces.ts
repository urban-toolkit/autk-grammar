import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs.geojson',
            outputTableName: 'manhattan',
            coordinateFormat: 'EPSG:4326',
            workspace: 'manhattan',
        },
        {
            type: 'csv',
            csvFileUrl: '/data/nyc_neigs.csv',
            outputTableName: 'city',
            geometryColumns: { wktColumnName: 'the_geom', coordinateFormat: 'EPSG:4326' },
            workspace: 'city',
        },
    ],
    map: [
        {
            workspace: 'manhattan',
            camera: { zoom: 8.1 },
            layerRefs: [{ dataRef: 'manhattan', title: 'Manhattan' }],
        },
        {
            workspace: 'city',
            camera: { zoom: 6.9 },
            layerRefs: [
                {
                    dataRef: 'city',
                    title: 'New York City by borough',
                    getFnv: 'BoroName',
                    colorMapInterpolator: ColorMapInterpolator.CAT_TABLEAU10,
                },
            ],
        },
    ],
};
