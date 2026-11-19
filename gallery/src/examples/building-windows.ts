import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

// Every window around Wall Street, three rows on each facade, placed as a render pass's building-windows viewpoints
// are: seen from above, the points trace each building's walls, in the color of its height.
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
        { type: 'windows', dataRef: 'wall_st_buildings', floors: 3, outputTableName: 'wall_st_windows' },
    ],
    map: {
        camera: { zoom: 13.8 },
        layerRefs: [
            { dataRef: 'wall_st_surface' },
            { dataRef: 'wall_st_roads' },
            {
                dataRef: 'wall_st_windows',
                title: 'Windows, by building height (m)',
                getFnv: 'buildingHeight',
                colorMapInterpolator: ColorMapInterpolator.SEQ_INFERNO,
                pointSize: 1.5,
            },
        ],
    },
};
