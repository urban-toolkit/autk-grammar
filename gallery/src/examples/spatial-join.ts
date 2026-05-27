import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:4326',
        },
        {
            type: 'csv',
            csvFileUrl: '/data/noise.csv',
            outputTableName: 'noise',
            geometryColumns: {
                latColumnName: 'Latitude',
                longColumnName: 'Longitude',
                coordinateFormat: 'EPSG:4326',
            },
        },
        {
            type: 'join',
            tableRootName: 'neighborhoods',
            tableJoinName: 'noise',
            groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }],
        },
    ],
    map: {
        layerRefs: [
            { dataRef: 'neighborhoods', getFnv: 'sjoin.count.noise', defaultFnv: 0 },
        ],
    },
};
