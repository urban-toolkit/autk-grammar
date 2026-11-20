import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            queryArea: {
                geocodeArea: 'New York',
                areas: ['Battery Park City', 'Financial District'],
            },
            outputTableName: 'table_osm',
            autoLoadLayers: {
                layers: ['buildings'] as Array<'surface' | 'parks' | 'water' | 'roads' | 'buildings'>,
                dropOsmTable: true,
            },
        },
    ],
    compute: [
        {
            dataRef: 'table_osm_buildings',
            attributes: { x: 'height', y: 'height' },
            outputColumnName: 'height_sq',
            wgslFunction: 'return x * y;',
        },
    ],
    map: {
        style: 'light',
        // The buildings of Battery Park City and the Financial District, about 2.1 by 2.6 km, fill most of the view,
        // tilted so they rise.
        camera: { zoom: 11.4, pitch: 40 },
        layerRefs: [
            {
                dataRef: 'table_osm_buildings',
                colorMapInterpolator: ColorMapInterpolator.DIV_RED_BLUE,
                getFnv: 'compute.height_sq',
            },
        ],
    },
};
