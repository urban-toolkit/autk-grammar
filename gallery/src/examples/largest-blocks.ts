import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';

// The ten largest blocks of touching buildings in the Financial District. A clusters pass gives each building the id of
// its block and keeps the result in autk-db (writeBack); a sql source that runs after compute counts the buildings of
// each block there. The map draws the blocks, and the chart the ten largest.
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
        {
            type: 'sql',
            outputTableName: 'largest_blocks',
            query: [
                "SELECT 'block ' || CAST(block_id AS VARCHAR) AS block, buildings FROM (",
                "SELECT CAST(properties->'compute'->>'block' AS INTEGER) AS block_id, CAST(count(*) AS INTEGER) AS buildings",
                'FROM fidi_blocks GROUP BY block_id',
                ') ORDER BY buildings DESC, block_id LIMIT 10',
            ].join(' '),
            after: 'compute',
        },
    ],
    compute: [
        { type: 'clusters', dataRef: 'fidi_buildings', outputColumnName: 'block', outputTableName: 'fidi_blocks', writeBack: true },
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
                title: 'Blocks of touching buildings',
                getFnv: 'compute.block',
                colorMapInterpolator: ColorMapInterpolator.SEQ_TURBO,
            },
        ],
    },
    plot: {
        dataRef: 'largest_blocks',
        mark: 'bar',
        axis: ['block', 'buildings'],
        axisLabels: ['Block', 'Buildings'],
        // The y axis counts buildings, so its labels are plain numbers: autk-plot's default, SI prefixes, writes 0.5 as 500m.
        tickFormats: [',~f', ',~f'],
    },
};
