import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'osm',
            pbfFileUrl: '/data/lower_mnt.osm.pbf',
            queryArea: { bbox: [-74.0125, 40.705, -74.008, 40.7085] },
            outputTableName: 'wall_st',
            autoLoadLayers: {
                layers: ['surface', 'roads', 'buildings'],
            },
        },
    ],
    compute: [
        {
            type: 'render',
            outputTableName: 'street_sky',
            layers: [{ id: 'buildings', dataRef: 'wall_st_buildings', type: 'buildings' }],
            viewpoints: {
                dataRef: 'wall_st_roads',
                sampling: { directions: 4, pitchDeg: 45 },
            },
            aggregation: { type: 'classes', includeBackground: true, backgroundLayerType: 'sky' },
            tileSize: 64,
        },
    ],
    map: {
        camera: { zoom: 13.8 },
        layerRefs: [
            { dataRef: 'wall_st_surface' },
            { dataRef: 'wall_st_buildings' },
            {
                dataRef: 'street_sky',
                title: 'Share of sky seen from the street',
                getFnv: 'compute.render.classes.sky',
                colorMapInterpolator: ColorMapInterpolator.SEQ_BLUES,
            },
        ],
    },
};
