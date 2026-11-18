import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    layout: { type: 'horizontal', gap: 12 },
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs_proj.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:3395',
        },
    ],
    map: {
        id: 'neighborhoodMap',
        camera: { zoom: 8.1 },
        layerRefs: [{ dataRef: 'neighborhoods', title: 'Neighborhood area', getFnv: 'shape_area' }],
    },
    plot: {
        id: 'shapePlot',
        dataRef: 'neighborhoods',
        mark: 'scatter',
        axis: ['shape_area', 'shape_leng'],
        title: 'Area and perimeter of each neighborhood',
        width: 560,
        height: 460,
        events: ['click', 'brush'],
    },
    links: [{ source: 'shapePlot', target: 'neighborhoodMap', layer: 'Neighborhood area' }],
};
