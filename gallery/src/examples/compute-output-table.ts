import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            pbfFileUrl: '/data/lower_mnt.osm.pbf',
            queryArea: { bbox: [-74.015, 40.703, -74.006, 40.711] },
            outputTableName: 'fidi',
            autoLoadLayers: {
                layers: ['surface', 'parks', 'water', 'roads', 'buildings'],
            },
        },
    ],
    compute: [
        {
            dataRef: 'fidi_buildings',
            attributes: { meters: 'height' },
            outputColumnName: 'feet',
            wgslFunction: 'return meters * 3.28084;',
            outputTableName: 'building_heights',
            layerType: 'polygons',
        },
    ],
    map: {
        camera: { zoom: 12.6 },
        layerRefs: [
            { dataRef: 'fidi_surface' },
            { dataRef: 'fidi_parks' },
            { dataRef: 'fidi_water' },
            { dataRef: 'fidi_roads' },
            {
                dataRef: 'building_heights',
                title: 'Building height (ft)',
                getFnv: 'compute.feet',
                colorMapInterpolator: ColorMapInterpolator.SEQ_VIRIDIS,
            },
        ],
    },
};
