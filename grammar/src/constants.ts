/** OSM layer a data source can split out, or a generic geometry layer. */
export type LayerType = 'surface' | 'water' | 'parks' | 'roads' | 'buildings' | 'points' | 'polygons' | 'polylines' | 'raster';

/** Kind of data source; selects which fields a `data` entry takes. */
export type DataSourceType = 'osm' | 'csv' | 'json' | 'geojson' | 'geotiff' | 'heatmap' | 'join' | 'sql' | 'update' | 'drop';

/** Color scheme for a colored map layer: `scheme*` names are categorical, `interpolate*` names are sequential or diverging. */
export enum ColorMapInterpolator {
  CAT_ACCENT = 'schemeAccent',
  CAT_DARK2 = 'schemeDark2',
  CAT_CATEGORY10 = 'schemeCategory10',
  CAT_OBSERVABLE10 = 'schemeObservable10',
  CAT_PAIRED = 'schemePaired',
  CAT_PASTEL1 = 'schemePastel1',
  CAT_PASTEL2 = 'schemePastel2',
  CAT_SET1 = 'schemeSet1',
  CAT_SET2 = 'schemeSet2',
  CAT_SET3 = 'schemeSet3',
  CAT_TABLEAU10 = 'schemeTableau10',
  SEQ_REDS = 'interpolateReds',
  SEQ_BLUES = 'interpolateBlues',
  SEQ_GREENS = 'interpolateGreens',
  SEQ_GREYS = 'interpolateGreys',
  SEQ_ORANGES = 'interpolateOranges',
  SEQ_PURPLES = 'interpolatePurples',
  SEQ_TURBO = 'interpolateTurbo',
  SEQ_VIRIDIS = 'interpolateViridis',
  SEQ_INFERNO = 'interpolateInferno',
  SEQ_MAGMA = 'interpolateMagma',
  SEQ_PLASMA = 'interpolatePlasma',
  SEQ_CIVIDIS = 'interpolateCividis',
  SEQ_WARM = 'interpolateWarm',
  SEQ_COOL = 'interpolateCool',
  SEQ_CUBEHELIX_DEFAULT = 'interpolateCubehelixDefault',
  SEQ_BU_GN = 'interpolateBuGn',
  SEQ_BU_PU = 'interpolateBuPu',
  SEQ_GN_BU = 'interpolateGnBu',
  SEQ_OR_RD = 'interpolateOrRd',
  SEQ_PU_BU_GN = 'interpolatePuBuGn',
  SEQ_PU_BU = 'interpolatePuBu',
  SEQ_PU_RD = 'interpolatePuRd',
  SEQ_RD_PU = 'interpolateRdPu',
  SEQ_YL_GN_BU = 'interpolateYlGnBu',
  SEQ_YL_GN = 'interpolateYlGn',
  SEQ_YL_OR_BR = 'interpolateYlOrBr',
  SEQ_YL_OR_RD = 'interpolateYlOrRd',
  DIV_BR_BG = 'interpolateBrBG',
  DIV_PR_GN = 'interpolatePRGn',
  DIV_PI_YG = 'interpolatePiYG',
  DIV_PU_OR = 'interpolatePuOr',
  DIV_RED_BLUE = 'interpolateRdBu',
  DIV_RED_GREY = 'interpolateRdGy',
  DIV_RED_YELLOW_BLUE = 'interpolateRdYlBu',
  DIV_RED_YELLOW_GREEN = 'interpolateRdYlGn',
  DIV_SPECTRAL = 'interpolateSpectral',
}

/** A categorical color scheme: a `scheme*` name, one color for each category. */
export type CategoricalColorMapInterpolator =
  | ColorMapInterpolator.CAT_ACCENT
  | ColorMapInterpolator.CAT_DARK2
  | ColorMapInterpolator.CAT_CATEGORY10
  | ColorMapInterpolator.CAT_OBSERVABLE10
  | ColorMapInterpolator.CAT_PAIRED
  | ColorMapInterpolator.CAT_PASTEL1
  | ColorMapInterpolator.CAT_PASTEL2
  | ColorMapInterpolator.CAT_SET1
  | ColorMapInterpolator.CAT_SET2
  | ColorMapInterpolator.CAT_SET3
  | ColorMapInterpolator.CAT_TABLEAU10;

/** A sequential or diverging color scheme: an `interpolate*` name, a color for each number of a scale. */
export type ContinuousColorMapInterpolator =
  | ColorMapInterpolator.SEQ_REDS
  | ColorMapInterpolator.SEQ_BLUES
  | ColorMapInterpolator.SEQ_GREENS
  | ColorMapInterpolator.SEQ_GREYS
  | ColorMapInterpolator.SEQ_ORANGES
  | ColorMapInterpolator.SEQ_PURPLES
  | ColorMapInterpolator.SEQ_TURBO
  | ColorMapInterpolator.SEQ_VIRIDIS
  | ColorMapInterpolator.SEQ_INFERNO
  | ColorMapInterpolator.SEQ_MAGMA
  | ColorMapInterpolator.SEQ_PLASMA
  | ColorMapInterpolator.SEQ_CIVIDIS
  | ColorMapInterpolator.SEQ_WARM
  | ColorMapInterpolator.SEQ_COOL
  | ColorMapInterpolator.SEQ_CUBEHELIX_DEFAULT
  | ColorMapInterpolator.SEQ_BU_GN
  | ColorMapInterpolator.SEQ_BU_PU
  | ColorMapInterpolator.SEQ_GN_BU
  | ColorMapInterpolator.SEQ_OR_RD
  | ColorMapInterpolator.SEQ_PU_BU_GN
  | ColorMapInterpolator.SEQ_PU_BU
  | ColorMapInterpolator.SEQ_PU_RD
  | ColorMapInterpolator.SEQ_RD_PU
  | ColorMapInterpolator.SEQ_YL_GN_BU
  | ColorMapInterpolator.SEQ_YL_GN
  | ColorMapInterpolator.SEQ_YL_OR_BR
  | ColorMapInterpolator.SEQ_YL_OR_RD
  | ColorMapInterpolator.DIV_BR_BG
  | ColorMapInterpolator.DIV_PR_GN
  | ColorMapInterpolator.DIV_PI_YG
  | ColorMapInterpolator.DIV_PU_OR
  | ColorMapInterpolator.DIV_RED_BLUE
  | ColorMapInterpolator.DIV_RED_GREY
  | ColorMapInterpolator.DIV_RED_YELLOW_BLUE
  | ColorMapInterpolator.DIV_RED_YELLOW_GREEN
  | ColorMapInterpolator.DIV_SPECTRAL;

/** Plot type. */
export type PlotMark = 'scatter' | 'bar' | 'line' | 'linechart' | 'parallel-coordinates' | 'table' | 'heatmatrix';

/** Transform presets a plot accepts. */
export type PlotTransformPreset = 'binning-1d' | 'binning-2d' | 'binning-events' | 'reduce-series' | 'sort';

/** Interaction a plot emits. */
export type PlotEvent = 'click' | 'brush' | 'brushY' | 'brushX';

/** How joined rows are combined per feature. */
export type AggregateFunction = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'weighted' | 'collect';

/**
 * How the rows near a heatmap cell are combined into its value: any aggregate function but `collect`, which lists the
 * rows, while a cell holds one value.
 */
export type HeatmapAggregateFunction = Exclude<AggregateFunction, 'collect'>;

/** How values are rescaled before coloring. */
export enum NormalizationMode {
    MIN_MAX = 'minMax',
    PERCENTILE = 'percentile',
}
