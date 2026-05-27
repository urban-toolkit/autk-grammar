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
                colorMapInterpolator: ColorMapInterpolator.SEQ_REDS,
                getFnv: 'shape_area',
                getFnvType: 'quantitative',
                normalization: {
                    mode: NormalizationMode.PERCENTILE,
                    lowerPercentile: 5,
                    upperPercentile: 95,
                },
            },
        ],
    },
};
