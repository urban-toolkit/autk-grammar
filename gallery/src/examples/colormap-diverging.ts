import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator, NormalizationMode } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:4326',
        },
    ],
    map: {
        style: 'light',
        layerRefs: [
            {
                dataRef: 'neighborhoods',
                colorMapInterpolator: ColorMapInterpolator.DIV_SPECTRAL,
                getFnv: 'shape_area',
                normalization: { mode: NormalizationMode.PERCENTILE },
            },
        ],
    },
};
