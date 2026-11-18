import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

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
            dataRef: 'neighborhoods',
            joinDataRef: 'noise',
            groupBy: [{ column: 'Unique Key', aggregateFn: 'count' }],
        },
        {
            type: 'sql',
            outputTableName: 'noisiest',
            query: "SELECT properties->>'ntaname' AS name, CAST(properties->'sjoin'->'count'->>'noise' AS INTEGER) AS complaints, geometry FROM neighborhoods ORDER BY complaints DESC NULLS LAST LIMIT 10",
            layerType: 'polygons',
        },
    ],
    map: {
        layerRefs: [
            { dataRef: 'neighborhoods', title: 'Manhattan neighborhoods', color: '#d9d9d9' },
            {
                dataRef: 'noisiest',
                title: 'Noise complaints, the ten noisiest',
                getFnv: 'complaints',
                colorMapInterpolator: ColorMapInterpolator.SEQ_REDS,
            },
        ],
    },
};
