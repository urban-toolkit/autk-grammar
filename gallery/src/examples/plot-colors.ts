import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

// The ten Manhattan neighborhoods with the most noise complaints, on a map and in a bar chart side by side. The layer
// and the chart color the counts in one scheme over one colorMapRange, so a count has one color in both. The chart
// titles its axes, and selects its first row, the noisiest neighborhood, which the map highlights through the link.
export const spec: UrbanSpec = {
    layout: { type: 'horizontal', gap: 12 },
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
        id: 'noiseMap',
        layerRefs: [
            { dataRef: 'neighborhoods', title: 'Manhattan neighborhoods', color: '#d9d9d9' },
            {
                dataRef: 'noisiest',
                title: 'Noise complaints',
                getFnv: 'complaints',
                colorMapInterpolator: ColorMapInterpolator.SEQ_REDS,
                colorMapRange: [0, 80],
            },
        ],
    },
    plot: {
        id: 'noiseChart',
        dataRef: 'noisiest',
        mark: 'bar',
        axis: ['name', 'complaints'],
        color: 'complaints',
        colorMapInterpolator: ColorMapInterpolator.SEQ_REDS,
        colorMapRange: [0, 80],
        axisLabels: ['Neighborhood', 'Noise complaints'],
        title: 'The ten noisiest neighborhoods',
        selection: [0],
        highlightColor: '#1f77b4',
        events: ['click'],
        width: 560,
        height: 460,
        margins: { left: 60, right: 20, top: 50, bottom: 170 },
    },
    links: [{ source: 'noiseChart', target: 'noiseMap', layer: 'Noise complaints' }],
};
