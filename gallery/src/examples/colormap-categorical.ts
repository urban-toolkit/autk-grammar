import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

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
        style: 'light',
        layerRefs: [
            {
                dataRef: 'roads',
                colorMapInterpolator: ColorMapInterpolator.CAT_OBSERVABLE10,
                getFnv: 'highway',
                colorMapDomain: ['primary', 'secondary'],
                catchAllCategory: 'other',
            },
        ],
    },
};
