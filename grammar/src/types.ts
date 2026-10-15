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
 * A longitude in degrees (WGS84).
 * @minimum -180
 * @maximum 180
 */
type Longitude = number;

/**
 * A latitude in degrees (WGS84).
 * @minimum -90
 * @maximum 90
 */
type Latitude = number;

/**
 * An area named by OpenStreetMap boundaries: sub-areas inside a geocoded region.
 */
export interface OsmNamedArea {
    /** Region to geocode, for example a city name. */
    geocodeArea: string;
    /** Sub-areas inside the region, for example neighborhood names. */
    areas: string[];
    /** Not with `geocodeArea` and `areas`. */
    bbox?: undefined;
}

/**
 * An area given as a box instead of boundary names. The box is the whole area: no boundary is read.
 */
export interface OsmBoundingBoxArea {
    /**
     * The box as `[west, south, east, north]` in degrees (WGS84), with west less than east and south less than
     * north. A box across the antimeridian is not supported. The Autark adapter cuts each layer to the box, but
     * keeps or drops each building whole.
     */
    bbox: [west: Longitude, south: Latitude, east: Longitude, north: Latitude];
    /** Not with `bbox`. */
    geocodeArea?: undefined;
    /** Not with `bbox`. */
    areas?: undefined;
}

/**
 * Loads OpenStreetMap data for a named area or a box, from Overpass or from a PBF extract.
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
    /** Area to load: sub-areas inside a geocoded region (`geocodeArea` with `areas`), or a box (`bbox`), not both. */
    queryArea: OsmNamedArea | OsmBoundingBoxArea;
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
 * A color as `#rrggbb`.
 * @pattern ^#[0-9a-fA-F]{6}$
 */
export type HexColor = string;

/**
 * How opaque a raster layer's cells are by value: autk-map's transfer function. A cell with no value is clear.
 */
export type RasterTransferFunction = {
    /**
     * `far-zero`: cells farther from `zeroCenter` are more opaque (autk-map's default). `near-zero`: cells closer to
     * `zeroCenter` are more opaque. `linear`: opacity grows from the lowest value to the highest.
     */
    mode?: 'near-zero' | 'far-zero' | 'linear',
    /**
     * Lowest opacity, from 0 to 1. Defaults to 0.
     * @minimum 0
     * @maximum 1
     */
    opacityMin?: number,
    /**
     * Highest opacity, from 0 to 1. Defaults to 1.
     * @minimum 0
     * @maximum 1
     */
    opacityMax?: number,
    /**
     * Exponent applied to a cell's place between the lowest and highest opacity. Defaults to 1.
     * @exclusiveMinimum 0
     */
    gamma?: number,
    /** Value the `far-zero` and `near-zero` modes measure from. Defaults to 0. */
    zeroCenter?: number,
}

/**
 * One layer drawn by a map.
 */
export type MapLayerSpec = {
    /** Name of the table to draw, as produced by a data source or a compute pass. */
    dataRef: string,
    /**
     * Name of the layer, shown as its legend's title. It becomes the layer's id in the map, so two layers of one
     * map cannot have the same title, and a title cannot be another layer's `dataRef` in that map. Without it, the
     * layer's id is its `dataRef`. Read by the Autark adapter; the deck.gl adapter ignores it.
     * @minLength 1
     */
    title?: string,
    /** Layer opacity, from 0 to 1. */
    opacity?: number,
    /**
     * Color of the layer, as `#rrggbb`. A layer with a color is drawn in it rather than by its `getFnv` value,
     * unless `isColorMap` is `true`. Raster layers are always colored by value. Read by the Autark adapter; the
     * deck.gl adapter ignores it.
     */
    color?: HexColor,
    /**
     * Outline of a polygon layer: its color, as `#rrggbb`, or `false` to draw no outline. Read by the Autark
     * adapter, which outlines polygon layers only; the deck.gl adapter ignores it.
     */
    stroke?: HexColor | false,
    /**
     * Width of the lines of a polylines or roads layer, in the map's planar units (about meters). It replaces
     * the widths a roads layer gives each kind of road. Read by the Autark adapter; the deck.gl adapter ignores it.
     * @exclusiveMinimum 0
     */
    width?: number,
    /** Color the layer by the value read with `getFnv`. */
    isColorMap?: boolean,
    /** Color scheme used when `isColorMap` is set. */
    colorMapInterpolator?: ColorMapInterpolator,
    /**
     * Value at the middle of a raster layer's color scale: the scale runs from this value less the farthest value's
     * distance to it, to this value plus that distance, so a diverging scheme's middle color marks it. Read by the
     * Autark adapter for raster layers; other layers and the deck.gl adapter ignore it.
     */
    colorMapCenter?: number,
    /**
     * Run a raster layer's color scale from its highest value to its lowest, so the scheme's first color marks the
     * highest value. Read by the Autark adapter for raster layers; other layers and the deck.gl adapter ignore it.
     */
    colorMapReverse?: boolean,
    /**
     * How opaque a raster layer's cells are by value, as autk-map's transfer function: for example
     * `{ opacityMin: 1, opacityMax: 1 }` draws every cell with a value fully opaque. Read by the Autark adapter for
     * raster layers; other layers and the deck.gl adapter ignore it.
     */
    transferFunction?: RasterTransferFunction,
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
    /**
     * Columns whose values name the rows a pick on this layer selects, so an app can link
     * the selection to other tables that hold those columns. Neither adapter reads it: the
     * Autark adapter's `map:picking` events still report feature ids.
     * @minItems 1
     */
    selectFields?: string[],
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
    /**
     * Columns whose values name the rows a selection in this plot selects, so an app can link
     * the selection to other tables that hold those columns. Neither adapter reads it: the
     * Autark adapter's `plot:selection` events still report feature ids.
     * @minItems 1
     */
    selectFields?: string[],
    width?: number,
    height?: number,
    margins?: { left: number; right: number; top: number; bottom: number },
    /** `dataRef` of the map layer this plot links its selection to. */
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
