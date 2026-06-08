import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export type Layout = 'map' | 'map+plot' | 'multi-map' | 'data-only';
export type AdapterName = 'autk' | 'deckgl';

export type ExampleModule = {
    spec: UrbanSpec;
    afterRun?: (grammar: unknown) => void | Promise<void>;
};

export type ExampleMeta = {
    title: string;
    layout: Layout;
    supportedAdapters: readonly AdapterName[];
    load: () => Promise<ExampleModule>;
};

export const EXAMPLES: Record<string, ExampleMeta> = {
    'geojson-vis': {
        title: 'GeoJSON Visualization',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/geojson-vis'),
    },
    'geojson-boundaries-vis': {
        title: 'GeoJSON Boundaries',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/geojson-boundaries-vis'),
    },
    'geojson-lines-vis': {
        title: 'GeoJSON Lines',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/geojson-lines-vis'),
    },
    'standalone-geojson-vis': {
        title: 'Standalone GeoJSON',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/standalone-geojson-vis'),
    },
    'standalone-points-geojson-vis': {
        title: 'Points + Boundaries',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/standalone-points-geojson-vis'),
    },
    'colormap-categorical': {
        title: 'Categorical Colormap',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/colormap-categorical'),
    },
    'colormap-diverging': {
        title: 'Diverging Colormap',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/colormap-diverging'),
    },
    'colormap-normalization': {
        title: 'Colormap Normalization',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/colormap-normalization'),
    },
    'layer-opacity': {
        title: 'Layer Opacity (OSM + GeoJSON)',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/layer-opacity'),
    },
    'load-csv': {
        title: 'Load CSV',
        layout: 'data-only',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/load-csv'),
    },
    'load-multiple': {
        title: 'Load CSV + JSON',
        layout: 'data-only',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/load-multiple'),
    },
    'osm-layers-api': {
        title: 'OSM: NYC Battery Park',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api'),
    },
    'osm-layers-api-manhattan': {
        title: 'OSM: Manhattan (All Layers)',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-manhattan'),
    },
    'osm-layers-api-manhattan-surface': {
        title: 'OSM: Manhattan Surface',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-manhattan-surface'),
    },
    'osm-layers-api-manhattan-water': {
        title: 'OSM: Manhattan Water',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-manhattan-water'),
    },
    'osm-layers-api-manhattan-parks': {
        title: 'OSM: Manhattan Parks',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-manhattan-parks'),
    },
    'osm-layers-api-manhattan-s+p': {
        title: 'OSM: Manhattan Surface + Parks',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-manhattan-s+p'),
    },
    'osm-layers-api-manhattan-s+w': {
        title: 'OSM: Manhattan Surface + Water',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-manhattan-s+w'),
    },
    'osm-layers-api-manhattan-w+p': {
        title: 'OSM: Manhattan Water + Parks',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-manhattan-w+p'),
    },
    'osm-layers-api-chicago': {
        title: 'OSM: Chicago Loop',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-chicago'),
    },
    'osm-layers-api-niteroi': {
        title: 'OSM: Niterói, Brazil',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-niteroi'),
    },
    'osm-layers-api-paris': {
        title: 'OSM: Paris',
        layout: 'map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-paris'),
    },
    'osm-layers-api-multi': {
        title: 'OSM: NYC Dual Map',
        layout: 'multi-map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/osm-layers-api-multi'),
    },
    'osm-layers-pbf': {
        title: 'OSM: PBF File',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/osm-layers-pbf'),
    },
    'heatmap-vis': {
        title: 'Heatmap: OSM + CSV',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/heatmap-vis'),
    },
    'heatmap-vis-geojson': {
        title: 'Heatmap: GeoJSON + CSV',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/heatmap-vis-geojson'),
    },
    'compute-function': {
        title: 'Compute: Custom Function',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/compute-function'),
    },
    'compute-osm-function': {
        title: 'Compute: OSM Function',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/compute-osm-function'),
    },
    'property-func': {
        title: 'Compute: Height² (data only)',
        layout: 'data-only',
        supportedAdapters: ['autk'],
        load: () => import('./examples/property-func'),
    },
    'property-func-map': {
        title: 'Compute: Height² (map)',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/property-func-map'),
    },
    'property-array-func': {
        title: 'Compute: Array Average',
        layout: 'data-only',
        supportedAdapters: ['autk'],
        load: () => import('./examples/property-array-func'),
    },
    'property-linear-regression': {
        title: 'Compute: Linear Regression',
        layout: 'data-only',
        supportedAdapters: ['autk'],
        load: () => import('./examples/property-linear-regression'),
    },
    'property-matrix-func': {
        title: 'Compute: Matrix / Image',
        layout: 'data-only',
        supportedAdapters: ['autk'],
        load: () => import('./examples/property-matrix-func'),
    },
    'spatial-join': {
        title: 'Spatial Join: Neighborhoods × Noise',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/spatial-join'),
    },
    'spatial-join-buildings': {
        title: 'Spatial Join: Buildings × Noise',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/spatial-join-buildings'),
    },
    'spatial-join-near': {
        title: 'Spatial Join: Roads × Noise (near)',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/spatial-join-near'),
    },
    'spatial-join-multi': {
        title: 'Spatial Join: Multiple Joins',
        layout: 'map',
        supportedAdapters: ['autk'],
        load: () => import('./examples/spatial-join-multi'),
    },
    'scatterplot-brush': {
        title: 'Plot: Scatterplot + Brush',
        layout: 'map+plot',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/scatterplot-brush'),
    },
    'scatterplot-click': {
        title: 'Plot: Scatterplot + Click',
        layout: 'map+plot',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/scatterplot-click'),
    },
    'barchart-click': {
        title: 'Plot: Bar Chart + Click',
        layout: 'map+plot',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/barchart-click'),
    },
    'histogram-brush': {
        title: 'Plot: Histogram + Brush',
        layout: 'map+plot',
        supportedAdapters: ['autk'],
        load: () => import('./examples/histogram-brush'),
    },
    'histogram-brush-landuse': {
        title: 'Plot: Land Use Histogram',
        layout: 'map+plot',
        supportedAdapters: ['autk'],
        load: () => import('./examples/histogram-brush-landuse'),
    },
    'parallel-coordinates': {
        title: 'Plot: Parallel Coordinates',
        layout: 'map+plot',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/parallel-coordinates'),
    },
    'table-click': {
        title: 'Plot: Table + Click',
        layout: 'map+plot',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/table-click'),
    },
    'heatmatrix-click': {
        title: 'Plot: Heatmatrix + Click',
        layout: 'map+plot',
        supportedAdapters: ['autk'],
        load: () => import('./examples/heatmatrix-click'),
    },
    'temporal-events-click': {
        title: 'Plot: Temporal Events',
        layout: 'map+plot',
        supportedAdapters: ['autk'],
        load: () => import('./examples/temporal-events-click'),
    },
    'interaction-external': {
        title: 'Interactions: External Listen & Trigger',
        layout: 'map+plot',
        supportedAdapters: ['autk'],
        load: () => import('./examples/interaction-external'),
    },
    'multi-map': {
        title: 'Multi-Map: Dual View',
        layout: 'multi-map',
        supportedAdapters: ['autk', 'deckgl'],
        load: () => import('./examples/multi-map'),
    },
    'data-context-test': {
        title: 'Data Context: Lazy Access',
        layout: 'data-only',
        supportedAdapters: ['autk'],
        load: () => import('./examples/data-context-test'),
    },
};
