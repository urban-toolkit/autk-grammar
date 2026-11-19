import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

// The buildings of the Financial District that share walls, one color a block of them: a clusters pass gives each
// building the id of the block of touching buildings it is in.
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
        { type: 'clusters', dataRef: 'fidi_buildings', outputColumnName: 'block', outputTableName: 'fidi_blocks' },
    ],
    map: {
        camera: { zoom: 13, pitch: 40, bearing: 20 },
        layerRefs: [
            { dataRef: 'fidi_surface' },
            { dataRef: 'fidi_parks' },
            { dataRef: 'fidi_water' },
            { dataRef: 'fidi_roads' },
            {
                dataRef: 'fidi_blocks',
                title: 'Buildings that share walls',
                getFnv: 'compute.block',
                colorMapInterpolator: ColorMapInterpolator.SEQ_TURBO,
            },
        ],
    },
};
