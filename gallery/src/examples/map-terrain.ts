import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

// Manhattan's elevation in meters, about 30 m a cell, from the USGS 3D Elevation Program (3DEP, public domain), clipped
// to the island. The water around it has no value, so it lies at height 0. The map raises the island to its heights,
// drapes its neighborhoods and its elevation colors over them, and looks up the island from the south.
export const spec: UrbanSpec = {
    data: [
        { type: 'geojson', outputTableName: 'neighborhoods', geojsonFileUrl: '/data/mnt_neighs.geojson' },
        { type: 'geotiff', outputTableName: 'elevation', geotiffFileUrl: '/data/mnt_dem.tif', coordinateFormat: 'EPSG:3857' },
    ],
    map: {
        terrain: { dataRef: 'elevation' },
        camera: { pitch: 60, bearing: 30 },
        layerRefs: [
            { dataRef: 'neighborhoods', title: 'Neighborhoods', color: '#f2efe9', stroke: '#8c8c8c' },
            {
                dataRef: 'elevation',
                title: 'Elevation (m)',
                colorMapInterpolator: ColorMapInterpolator.SEQ_YL_GN,
                transferFunction: { opacityMin: 0.8, opacityMax: 0.8 },
            },
        ],
    },
};
