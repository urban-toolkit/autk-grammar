import { DataAdapter, PlotAdapter, MapAdapter, ComputeAdapter } from "./adapters";
import { BBox, GeoJsonProperties, Geometry } from 'geojson';
import { DataSourceType, LayerType, ColorMapInterpolator, PlotEvent, PlotTransformPreset, AggregateFunction, NormalizationMode } from "./constants";

/**
 * Fields every table-producing data source shares.
 */
export interface TableSourceBase {
    /** Name of the table this source creates. Later sources, compute passes, maps and plots refer to it by this name. */
    outputTableName: string
}

/**
 * A data source that produces a table.
 *
 * @deprecated Use {@link DataSourceSpec} or one of its members; kept so older code that names this type still compiles.
 */
export type TableSourceSpec = TableSourceBase & {
    type: DataSourceType
}

/**
 * Spatially joins one table onto another. The result replaces the root table.
 */
export interface JoinSourceSpec {
    type: 'join';
    /** Table that receives the joined columns. */
    tableRootName: string;
    /** Table whose rows are joined onto the root table. */
    tableJoinName: string;
    /** Join rows within `distance` (in workspace units) instead of by containment. */
    near?: { distance: number; useCentroid?: boolean };
    /** Aggregate the joined rows per root feature. */
    groupBy?: Array<{
        column: string;
        aggregateFn?: AggregateFunction;
        normalize?: boolean;
    }>;
}

/**
 * Aggregates a table onto a regular grid, producing a raster heatmap table.
 */
export interface HeatmapSourceSpec extends TableSourceBase {
    type: 'heatmap';
    /** Table whose rows are aggregated onto the grid. */
    tableJoinName: string;
    /** Radius around each grid cell, in workspace units, within which rows are aggregated. */
    near: { distance: number };
    groupBy?: Array<{
        column: string;
        aggregateFn?: AggregateFunction;
    }>;
    /** Grid resolution. */
    grid: {
        rows: number;
        columns: number;
    };
}

/**
 * Loads OpenStreetMap data for a named area, from Overpass or from a PBF extract.
 */
export interface OsmDataSourceSpec extends TableSourceBase {
    type: 'osm';
    /** URL of a local or remote `.osm.pbf` extract to read instead of querying Overpass. */
    pbfFileUrl?: string;
    /** Split the raw OSM table into one table per layer, named `<outputTableName>_<layer>`. */
    autoLoadLayers?: {
        /** Currently ignored by both adapters. */
        dropOsmTable?: boolean;
        layers: Array<LayerType>;
    };
    /** Area to load: the named sub-areas inside a geocoded region. */
    queryArea: {
        /** Region to geocode, for example a city name. */
        geocodeArea: string;
        /** Sub-areas inside the region, for example neighborhood names. */
        areas: string[];
    };
}

/**
 * Point geometry from two columns holding latitude and longitude.
 */
export type LatLongGeometryColumns = {
    latColumnName: string;
    longColumnName: string;
    /** CRS of the coordinates, as an EPSG string. Defaults to `'EPSG:4326'`. */
    coordinateFormat?: string;
}

/**
 * Geometry from one column holding WKT text such as `POLYGON((...))`. Read by the Autark adapter only.
 */
export type WktGeometryColumns = {
    wktColumnName: string;
    /** CRS of the geometry, as an EPSG string. Defaults to `'EPSG:4326'`. */
    coordinateFormat?: string;
}

/**
 * How rows become features: `true` reads the `Latitude` and `Longitude` columns, or name the columns.
 */
export type GeometryColumns = true | LatLongGeometryColumns | WktGeometryColumns;

/**
 * Loads a CSV table from exactly one of `csvFileUrl` or `csvObject`.
 * @if { "required": ["csvFileUrl"] }
 * @then { "not": { "required": ["csvObject"] } }
 * @else { "required": ["csvObject"] }
 */
export interface CsvDataSourceSpec extends TableSourceBase {
    type: 'csv';
    csvFileUrl?: string;
    /** Rows as arrays; the first row holds the column names. */
    csvObject?: unknown[][];
    delimiter?: string;
    geometryColumns?: GeometryColumns;
}

/**
 * Loads a JSON table from exactly one of `jsonFileUrl` or `jsonObject`.
 * @if { "required": ["jsonFileUrl"] }
 * @then { "not": { "required": ["jsonObject"] } }
 * @else { "required": ["jsonObject"] }
 */
export interface JsonDataSourceSpec extends TableSourceBase {
    type: 'json';
    jsonFileUrl?: string;
    jsonObject?: unknown[];
    geometryColumns?: GeometryColumns;
}

export interface BoundingBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * A GeoJSON feature as the loader accepts it: `geometry` may be null and `properties` may be omitted.
 */
export type InlineFeature = {
    type: 'Feature';
    geometry: Geometry | null;
    properties?: GeoJsonProperties;
    id?: string | number;
    bbox?: BBox;
}

/**
 * A GeoJSON FeatureCollection with at least one feature.
 */
export type InlineFeatureCollection = {
    type: 'FeatureCollection';
    /** @minItems 1 */
    features: InlineFeature[];
    bbox?: BBox;
}

/**
 * Loads a GeoJSON FeatureCollection from `geojsonFileUrl` or `geojsonObject`. When both are given, the Autark adapter reads the URL.
 * @if { "not": { "required": ["geojsonFileUrl"] } }
 * @then { "required": ["geojsonObject"] }
 */
export interface CustomDataSourceSpec extends TableSourceBase {
    type: 'geojson';
    geojsonFileUrl?: string;
    /**
     * GeoJSON FeatureCollection to load directly.
     *
     * Per RFC 7946, GeoJSON coordinates MUST be in WGS84 (EPSG:4326) longitude/latitude.
     * This is the default assumption when `coordinateFormat` is omitted.
     *
     * If your FeatureCollection is in a different CRS (e.g. a projected system such as
     * EPSG:3395), you MUST set `coordinateFormat` explicitly to match the actual CRS
     * of the input data. Omitting `coordinateFormat` when the data is not in EPSG:4326
     * will cause the spatial transform to produce invalid geometry.
     */
    geojsonObject?: InlineFeatureCollection;
    /**
     * Source coordinate reference system of the input data, expressed as an EPSG string
     * (e.g. `'EPSG:4326'`, `'EPSG:3395'`).
     *
     * Defaults to `'EPSG:4326'` (WGS84) when omitted, which is the correct value for
     * standards-compliant GeoJSON. Only set this when the source data deviates from
     * RFC 7946.
     */
    coordinateFormat?: string;
    boundingBox?: BoundingBox;
}

/**
 * One entry of `data`. The `type` field selects which fields apply.
 * @discriminator type
 */
export type DataSourceSpec = OsmDataSourceSpec | CsvDataSourceSpec | JsonDataSourceSpec | CustomDataSourceSpec | HeatmapSourceSpec | JoinSourceSpec;

/**
 * One layer drawn by a map.
 */
export type MapLayerSpec = {
    /** Name of the table to draw, as produced by a data source or a compute pass. */
    dataRef: string,
    /** Layer opacity, from 0 to 1. */
    opacity?: number,
    /** Color the layer by the value read with `getFnv`. */
    isColorMap?: boolean,
    /** Color scheme used when `isColorMap` is set. */
    colorMapInterpolator?: ColorMapInterpolator,
    /** Legend labels. Read by the deck.gl adapter; the Autark adapter ignores it. */
    colorMapLabels?: string[],
    /** Feature ids drawn as picked. Read by the deck.gl adapter; the Autark adapter ignores it. */
    pickedComps?: number[],
    /** How values are rescaled before coloring. */
    normalization?: { mode: NormalizationMode; lowerPercentile?: number; upperPercentile?: number },
    /** Load the layer without drawing it. */
    isSkip?: boolean,
    /** Allow picking features on this layer. */
    isPick?: boolean,
    /** Dot path to the thematic value, relative to `feature.properties` (for example `tags.highway` or `compute.result`). */
    getFnv?: string,
    /** `categorical` reads the value as a string for discrete palettes; `quantitative` reads it as a number for continuous scales. Read by the deck.gl adapter; the Autark adapter ignores it. */
    getFnvType?: 'categorical' | 'quantitative',
    /** Allowed category values; anything else is drawn as the catch-all category. Only used when `getFnvType` is `categorical`. */
    colorMapDomain?: string[],
    catchAllCategory?: string,
    /** Value used for features where `getFnv` resolves to nothing. Read by the deck.gl adapter; the Autark adapter ignores it. */
    defaultFnv?: string | number
}

/**
 * A map view.
 */
export type MapSpec = {
    /** Map style. */
    style?: string,
    /** Layers to draw, bottom first. Each names a table with `dataRef`. */
    layerRefs: MapLayerSpec[]
}

export interface PlotBase {
    /** Name of the table to plot. */
    dataRef: string,
    /**
     * Columns to plot, in axis order. At least one is required.
     * @minItems 1
     */
    axis: string[],
    color?: string,
    title?: string,
    /** Interactions the plot emits. */
    events?: PlotEvent[],
    width?: number,
    height?: number,
    margins?: { left: number; right: number; top: number; bottom: number },
    /** Layer id of a map this plot links its selection to. */
    mapRef?: string,
}

/**
 * Reshapes the table before plotting.
 */
export interface PlotTransformSpec<P extends PlotTransformPreset = PlotTransformPreset> {
    preset: P;
    options?: Record<string, unknown>;
}

/** A scatterplot of two or more columns. */
export interface ScatterPlotSpec extends PlotBase {
    mark: 'scatter';
    /**
     * Columns to plot, in axis order. At least two are required.
     * @minItems 2
     */
    axis: string[];
    transform?: PlotTransformSpec;
}

/** A bar chart. A transform, when given, must be `binning-1d`. */
export interface BarPlotSpec extends PlotBase {
    mark: 'bar';
    transform?: PlotTransformSpec<'binning-1d'>;
}

/** A line chart over a `reduce-series` or `binning-events` transform, which it requires. */
export interface LinePlotSpec extends PlotBase {
    mark: 'line' | 'linechart';
    transform: PlotTransformSpec<'reduce-series' | 'binning-events'>;
}

/** Parallel coordinates over the plotted columns. */
export interface ParallelCoordinatesPlotSpec extends PlotBase {
    mark: 'parallel-coordinates';
    transform?: PlotTransformSpec;
}

/** A table. A transform, when given, must be `sort`. */
export interface TablePlotSpec extends PlotBase {
    mark: 'table';
    transform?: PlotTransformSpec<'sort'>;
}

/** A heat matrix over a `binning-2d` transform, which it requires. */
export interface HeatmatrixPlotSpec extends PlotBase {
    mark: 'heatmatrix';
    transform: PlotTransformSpec<'binning-2d'>;
}

/**
 * A plot view. The `mark` field selects which transforms apply.
 * @discriminator mark
 */
export type PlotSpec = ScatterPlotSpec | BarPlotSpec | LinePlotSpec | ParallelCoordinatesPlotSpec | TablePlotSpec | HeatmatrixPlotSpec;

/**
 * Reads a uniform's value from a feature of a loaded table instead of writing it inline.
 */
export type FromFeatureDirective = {
    fromFeature: {
        /** Table to read from. */
        layer: string;
        /** Dot path from the feature root, for example `properties.height` or `geometry.coordinates.0`. */
        path: string;
        /** Feature index to read. Defaults to 0. */
        index?: number;
        /**
         * Iterate over every feature of `layer`. `all` runs the shader once per feature and sums the
         * outputs. `batched` packs every feature's value into a uniform array named after this entry
         * (matrix entries become each feature's bounding box as four corners), adds a `num_features`
         * uniform, and runs the shader once.
         */
        iterate?: 'all' | 'batched';
        /** With `iterate: 'batched'`, drop features whose `path` does not resolve to a finite value. */
        required?: boolean;
    };
    /** Value used when `path` does not resolve. Without it the entry is dropped. */
    default?: number | number[][];
    /** Matrix column count, for entries in `uniformMatrices`. */
    cols?: number;
}

type ComputeBase = {
    /** Name of the table the shader runs over, one invocation per feature. */
    dataRef: string,
    /** Maps WGSL variable names to feature property paths. */
    attributes: Record<string, string>,
    attributeArrays?: Record<string, number>,
    attributeMatrices?: Record<string, { rows: number | 'auto'; cols: number }>,
    /** Scalar constants shared by every invocation, written inline or read from a feature. */
    uniforms?: Record<string, number | FromFeatureDirective>,
    uniformArrays?: Record<string, number[]>,
    /** Matrix constants shared by every invocation, written inline or read from a feature. */
    uniformMatrices?: Record<string, { data: number[][]; cols: number } | FromFeatureDirective>,
    /** WGSL body of the compute function. An array is joined with newlines, which keeps long shaders readable in JSON. */
    wglsFunction: string | string[]
}

/**
 * A GPU compute pass over a table. Results are written to `feature.properties.compute.<column>`.
 * It needs `outputColumnName` for a single result or `outputColumns` for several.
 */
export type ComputeSpec = ComputeBase & (
    | {
        /** Column written when the shader returns one value. */
        outputColumnName: string,
        /** @minItems 1 */
        outputColumns?: string[]
    }
    | {
        outputColumnName?: string,
        /**
         * Columns written when the shader returns several values, in order.
         * @minItems 1
         */
        outputColumns: string[]
    }
)

/**
 * An Autark grammar specification. It names at least one of `data`, `compute`, `map` or `plot`.
 */
export type UrbanSpec = {
    /** URL of the JSON Schema this specification follows. */
    $schema?: string,
    /** Tables to load, in order. */
    data?: DataSourceSpec[],
    /** Compute passes, run in order after the data is loaded. */
    compute?: ComputeSpec[],
    /** One map, or several. */
    map?: MapSpec[] | MapSpec,
    /** One plot, or several. */
    plot?: PlotSpec[] | PlotSpec
}

export type EngineOptions = {
    spec: UrbanSpec,
    adapters: {
        db: DataAdapter,
        map: MapAdapter,
        plot: PlotAdapter,
        compute: ComputeAdapter
    }
}
