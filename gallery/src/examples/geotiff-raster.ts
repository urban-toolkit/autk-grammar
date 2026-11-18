import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geotiff',
            geotiffFileUrl: '/data/niteroi_lst_verao_2001_2024.tif',
            outputTableName: 'lst',
            coordinateFormat: 'EPSG:4326',
            maxRasterCells: 200,
            resampleMethod: 'nearest',
        },
        {
            type: 'geojson',
            outputTableName: 'extent',
            geojsonObject: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: {},
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [-43.1391, -22.9897],
                                    [-42.943, -22.9897],
                                    [-42.943, -22.8538],
                                    [-43.1391, -22.8538],
                                    [-43.1391, -22.9897],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
    ],
    map: {
        camera: { zoom: 8.8 },
        layerRefs: [
            { dataRef: 'extent', title: 'Raster extent' },
            {
                dataRef: 'lst',
                title: 'Summer surface temperature, 2024 (°C)',
                getFnv: 'band_24',
                colorMapInterpolator: ColorMapInterpolator.SEQ_YL_OR_RD,
                transferFunction: { opacityMin: 1, opacityMax: 1 },
            },
        ],
    },
};
