import type { FeatureCollection } from 'geojson';
import { MapAdapter, MapLayerSpec, MapSpec, CameraSpec, TerrainSpec } from '@urban-toolkit/the-urban-grammar';
import { enterWorkspace, tableKey } from '../workspace';
import { Targets, ComputeCache, ComputeLayerTypes } from '../types';
import { DrawnLayers, LayerExports, exportKey, exportOf, exportOptions, mapIdOf } from '../drawn';
import { rowKeys } from '../rows';
import { AutkMap } from '@urban-toolkit/autk-map';
import type { LayerRenderInfo, MapStyleShape } from '@urban-toolkit/autk-map';
import { ColorMap, ColorMapDomainStrategy, ColorMapInterpolator } from '@urban-toolkit/autk-core';
import type { ColorHEX, ColorMapConfig, ColorRGB, LayerType, TransferFunction } from '@urban-toolkit/autk-core';
import { AutkDb } from '@urban-toolkit/autk-db';
import { extentOf } from './data';
import { checkPointSize, planarPointSize } from '../point-size';
import { HEX_COLOR, buildDomainSpec, colorMapRangeRefusal } from '../color-keys';

/** The id a layer has in its map: its `title`, else its `dataRef`. */
export function layerIdOf(layerRef: MapLayerSpec): string {
    return typeof layerRef.title === 'string' && layerRef.title !== '' ? layerRef.title : layerRef.dataRef;
}

/** Refuses a map whose layers would share an id. */
function checkLayerIds(spec: MapSpec, index: number): void {
    const ids = new Set<string>();
    for (const layerRef of spec.layerRefs) {
        const id = layerIdOf(layerRef);
        if (ids.has(id))
            throw new Error(`Map ${index} draws two layers with the id "${id}". A layer's id is its title, else its dataRef: give each layer of a map its own title.`);
        ids.add(id);
    }
}

function hexColor(value: string, key: string, layerId: string): ColorRGB {
    if (!HEX_COLOR.test(value))
        throw new Error(`Layer "${layerId}": ${key} must be a color written #rrggbb, not "${value}".`);
    return ColorMap.hexToRgb(value as ColorHEX);
}

/** What `color`, `stroke` and `width` set on the layer's autk-map render info. */
function styleRenderInfo(layerRef: MapLayerSpec, layerId: string): Partial<LayerRenderInfo> {
    const renderInfo: Partial<LayerRenderInfo> = {};
    if (layerRef.color != null)
        renderInfo.color = hexColor(layerRef.color, 'color', layerId);
    if (layerRef.stroke === false)
        renderInfo.showBorders = false;
    else if (layerRef.stroke != null)
        renderInfo.strokeColor = hexColor(layerRef.stroke, 'stroke', layerId);
    if (layerRef.width != null)
        renderInfo.polylinesWidth = layerRef.width;
    return renderInfo;
}

/**
 * Whether the layer is colored by value. An explicit `isColorMap` decides. A raster layer is colored by value
 * either way, and this only shows or hides its legend. Otherwise a layer with a `color` is drawn in it, and a
 * layer with a scheme or a `getFnv` value is colored by value.
 */
function colorsByValue(layerRef: MapLayerSpec, type: LayerType): boolean {
    if (layerRef.isColorMap != null) return layerRef.isColorMap;
    if (type === 'raster')
        return layerRef.colorMapInterpolator != null || layerRef.colorMapRange != null || layerRef.colorMapCenter != null
            || layerRef.colorMapReverse === true;
    if (layerRef.color != null) return false;
    return layerRef.colorMapInterpolator != null || layerRef.getFnv != null;
}

/** A raster band's values, as autk-map reads them. */
function bandValues(collection: { features?: { properties?: unknown }[] }, band: string): Float32Array | null {
    const values = (collection.features?.[0]?.properties as Record<string, unknown> | undefined)?.[band];
    if (values instanceof Float32Array) return values;
    if ((ArrayBuffer.isView(values) && !(values instanceof DataView)) || Array.isArray(values))
        return Float32Array.from(values as ArrayLike<number>, (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN));
    return null;
}

/**
 * The domain of a raster's color scale when the layer sets a range, a center or reverse, or `undefined` when it
 * sets none of them, the scheme is categorical, or, without a range, the band has no value. A range is the domain:
 * `[low, high]`, or `[low, center, high]` with a center. Without one, a scale centered on `center` runs from the
 * center less the farthest value's distance to it, to the center plus that distance; when every value is the
 * center, it is not centered. Otherwise it is the domain autk-map resolves from `config`. `reverse` turns it around.
 */
export function rasterScaleDomain(
    values: Float32Array | null, config: ColorMapConfig, center?: number, reverse?: boolean, range?: [number, number],
): number[] | undefined {
    if (ColorMap.isCategorical(config.interpolator)) return undefined;
    if (range != null) {
        const domain = center != null ? [range[0], center, range[1]] : [range[0], range[1]];
        return reverse === true ? domain.reverse() : domain;
    }
    if (!values) return undefined;
    let reach = 0;
    let finite = 0;
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (!Number.isFinite(value)) continue;
        finite++;
        if (center != null) reach = Math.max(reach, Math.abs(value - center));
    }
    const centered = center != null && reach > 0;
    if (finite === 0 || (!centered && reverse !== true)) return undefined;
    const domain = centered && center != null
        ? [center - reach, center, center + reach]
        : ColorMap.resolveDomainFromData(values, config) as number[];
    return reverse === true ? [...domain].reverse() : domain;
}

/**
 * The domain of a vector layer's color scale: its range, unless the scheme is categorical. autk-map colors a vector
 * layer on the GPU from its domain's first value to its last, which must be the higher, so the domain is neither
 * centered nor reversed.
 */
function vectorScaleDomain(config: ColorMapConfig, range?: [number, number]): number[] | undefined {
    if (range == null || ColorMap.isCategorical(config.interpolator)) return undefined;
    return [range[0], range[1]];
}

/**
 * Refuses a `colorMapRange` that is not two numbers with low less than high, one set with `colorMapDomain`, and
 * one whose layer's `colorMapCenter` lies outside it. The schema refuses the same shapes and the pairing with
 * `colorMapDomain`, but JSON Schema cannot compare two values: a low above its high and a center outside the range
 * are refused only here.
 */
function checkColorMapRange(layerRef: MapLayerSpec): void {
    const range: unknown = layerRef.colorMapRange;
    if (range === undefined) return;
    const refuse = (message: string) => new Error(`Layer "${layerIdOf(layerRef)}": ${message}`);
    const refusal = colorMapRangeRefusal(range, layerRef.colorMapDomain);
    if (refusal)
        throw refuse(refusal);
    const [low, high] = range as [number, number];
    const center = layerRef.colorMapCenter;
    if (center != null && (center < low || center > high))
        throw refuse(`colorMapCenter (${center}) must lie within colorMapRange [${low}, ${high}].`);
}

/** The colors a style of the spec's own gives, all of which autk-map's `setCustomStyle` takes. */
const STYLE_COLORS = ['background', 'surface', 'parks', 'water', 'roads', 'buildings', 'points', 'polylines', 'polygons'] as const;

/**
 * Refuses a `style` that is neither a name nor the nine colors of a style, each `#rrggbb`, and a `highlightColor` or an
 * `invalidValueColor` that is not `#rrggbb`. autk-map would throw at the first color a style lacks.
 */
function checkMapColors(spec: MapSpec, index: number): void {
    const refuse = (message: string) => new Error(`Map ${index}: ${message}`);
    const style: unknown = spec.style;
    if (style !== undefined && typeof style !== 'string') {
        if (style === null || typeof style !== 'object' || Array.isArray(style))
            throw refuse(`style must be the name of one of autk-map's styles or the colors of a style, not ${JSON.stringify(style)}.`);
        const missing = STYLE_COLORS.filter((key) => !(key in style));
        if (missing.length > 0)
            throw refuse(`style gives no color for ${missing.join(', ')}: a style of the spec's own gives each of ${STYLE_COLORS.join(', ')}.`);
        for (const key of STYLE_COLORS) {
            const color = (style as Record<string, unknown>)[key];
            if (typeof color !== 'string' || !HEX_COLOR.test(color))
                throw refuse(`style.${key} must be a color written #rrggbb, not ${JSON.stringify(color)}.`);
        }
    }
    for (const key of ['highlightColor', 'invalidValueColor'] as const) {
        const color: unknown = spec[key];
        if (color !== undefined && (typeof color !== 'string' || !HEX_COLOR.test(color)))
            throw refuse(`${key} must be a color written #rrggbb, not ${JSON.stringify(color)}.`);
    }
}

/** Sets a map's style, and its highlight and invalid-value colors, which autk-map keeps for each map. */
function applyMapColors(map: AutkMap, spec: MapSpec): void {
    if (typeof spec.style === 'string')
        map.style.setPredefinedStyle(spec.style);
    else if (spec.style)
        map.style.setCustomStyle(spec.style as MapStyleShape);
    if (spec.highlightColor !== undefined)
        map.style.setHighlightColor(spec.highlightColor as ColorHEX);
    if (spec.invalidValueColor !== undefined)
        map.style.setInvalidValueColor(spec.invalidValueColor as ColorHEX);
}

/** The layer types that draw each kind of geometry, and how a refusal says so. */
const LAYER_KINDS: ReadonlyArray<{ types: readonly LayerType[]; drawn: string }> = [
    { types: ['points'], drawn: 'a table of points is drawn as points' },
    { types: ['polylines', 'roads'], drawn: 'a table of lines is drawn as polylines or roads' },
    { types: ['polygons', 'surface', 'parks', 'water', 'buildings'], drawn: 'a table of polygons is drawn as polygons, surface, parks, water or buildings' },
    { types: ['raster'], drawn: 'a raster table is drawn as raster' },
];

/**
 * The type the map draws a layer's table as: its `layerType`, which is refused when it is not of the table's kind of
 * geometry, else the table's own type.
 */
function drawnType(layerRef: MapLayerSpec, tableType: LayerType | undefined, layerId: string): LayerType {
    const wanted = layerRef.layerType;
    if (wanted === undefined || tableType === undefined) return (wanted ?? tableType) as LayerType;
    const kind = LAYER_KINDS.find((candidate) => candidate.types.includes(tableType));
    if (!kind || kind.types.includes(wanted)) return wanted;
    throw new Error(`Layer "${layerId}": layerType "${wanted}" cannot draw the table "${layerRef.dataRef}", a ${tableType} table: ${kind.drawn}.`);
}

/** Refuses a list of feature positions that is not whole numbers from 0, as `key` of a layer. */
function checkPositions(positions: unknown, key: string, layerId: string): void {
    if (!Array.isArray(positions) || !positions.every((position) => Number.isInteger(position) && position >= 0))
        throw new Error(`Layer "${layerId}": ${key} must list the positions of features the layer draws, whole numbers from 0, not ${JSON.stringify(positions)}.`);
}

/** Refuses positions on a raster layer, which draws no features, and positions past the last feature a layer draws. */
function checkDrawnPositions(positions: readonly number[], key: string, layerId: string, type: LayerType, count: number): void {
    if (type === 'raster')
        throw new Error(`Layer "${layerId}": ${key} names features, and a raster layer has none.`);
    const past = positions.find((position) => position >= count);
    if (past !== undefined)
        throw new Error(`Layer "${layerId}": ${key} names position ${past}, past the ${count} features the layer draws.`);
}

/**
 * Refuses a layer's `pickedComps` when the layer does not set `isPick`, or when a later layer of its map sets it: autk-map
 * draws picked features only on the layer that picks, and lets one layer of a map pick, the last that asks.
 */
function checkPickedComps(spec: MapSpec): void {
    spec.layerRefs.forEach((layerRef, at) => {
        if (layerRef.pickedComps === undefined) return;
        const layerId = layerIdOf(layerRef);
        checkPositions(layerRef.pickedComps, 'pickedComps', layerId);
        if (layerRef.isPick !== true)
            throw new Error(`Layer "${layerId}": pickedComps draws features as picked, which autk-map does only on the layer that picks: set isPick: true.`);
        const later = spec.layerRefs.slice(at + 1).find((other) => other.isPick === true);
        if (later)
            throw new Error(`Layer "${layerId}": pickedComps draws features as picked on the layer that picks, but layer "${layerIdOf(later)}", after it, picks too: autk-map lets one layer of a map pick, the last.`);
    });
}

function valueAtPath(obj: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
        if (acc == null || typeof acc !== 'object') return undefined;
        return (acc as Record<string, unknown>)[key];
    }, obj);
}

function setValueAtPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
    const keys = path.split('.');
    const result = { ...obj };
    let current = result as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
        current[keys[i]] = { ...(current[keys[i]] as Record<string, unknown> ?? {}) };
        current = current[keys[i]] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;
    return result;
}

/**
 * Resolves a grammar value path such as `count.noise` to the raster band that holds it, by the band's id (`band_1`, ...)
 * or its label: autk-db labels a heatmap's bands `<aggregateFn>_<table>`. Without a path, the first band. A raster of
 * one band is read whatever the path names; on a raster of several, a path that names none of them is refused, since
 * another band would show other values. `refuse` makes the error from the sentence that says so.
 */
function rasterBand(collection: { features?: { properties?: unknown }[] }, path: string | undefined, refuse: (message: string) => Error): string {
    const props = collection.features?.[0]?.properties as { bands?: { id: string; label?: string }[] } | undefined;
    const bands = props?.bands ?? [];
    if (path === undefined) return bands[0]?.id ?? '';
    const band = bands.find((b) => b.id === path || b.label === path.replace(/\./g, '_'));
    if (band) return band.id;
    if (bands.length > 1) {
        const names = bands.map((b) => (b.label && b.label !== b.id ? `${b.id} (${b.label})` : b.id));
        throw refuse(`"${path}" names none of its ${bands.length} bands: ${names.join(', ')}.`);
    }
    return bands[0]?.id ?? path;
}

/**
 * Why a run refuses `camera`, or `undefined` when it takes it: a pitch that is not at least 0 and less than 90 degrees.
 * At 90 the eye would sit on the ground, edge-on to the map's flat layers, and autk-map's pan, which moves the eye by
 * its height, would stand still. The schema refuses the same pitches.
 */
function cameraRefusal(camera: CameraSpec): string | undefined {
    const { pitch } = camera as { pitch?: unknown };
    if (pitch === undefined || (typeof pitch === 'number' && pitch >= 0 && pitch < 90)) return undefined;
    const shown = typeof pitch === 'number' ? String(pitch) : JSON.stringify(pitch);
    return `camera.pitch must be at least 0 and less than 90 degrees, not ${shown}: at 90 the eye would sit on the ground, edge-on to the map's flat layers, and the map could not pan.`;
}

/**
 * Moves a map's camera as `camera` says, from the view that fits the map's layers. The camera reports each change,
 * so the map redraws without a request. It refuses a pitch that is not at least 0 and less than 90 degrees.
 *
 * The map adapter calls it once the map's layers are loaded and before the map's first `draw()`. A host that builds
 * its own map from a spec's `map` entry calls it at the same point, so the map looks from where the grammar's would.
 */
export function applyCamera(map: AutkMap, camera: CameraSpec): void {
    const refused = cameraRefusal(camera);
    if(refused) throw new Error(refused);
    if(camera.zoom === undefined && !camera.pitch && !camera.bearing) return;

    // Turn the view around the point it looks at: the eye moves on a sphere around that point, so the data stays
    // in view at any pitch. `pitch` is the angle from straight down and `bearing` the compass heading of the view,
    // clockwise from north.
    const view = map.camera;
    const [x, y] = view.getLookAt();
    const distance = camera.zoom !== undefined ? 10000 / Math.pow(2, camera.zoom - 10) : Math.abs(view.getEye()[2]);
    const pitch = (camera.pitch ?? 0) * Math.PI / 180;
    const bearing = (camera.bearing ?? 0) * Math.PI / 180;
    const eye = [
        x - distance * Math.sin(pitch) * Math.sin(bearing),
        y - distance * Math.sin(pitch) * Math.cos(bearing),
        distance * Math.cos(pitch),
    ];
    // The view's up direction: across the line of sight at any pitch, toward the far side of the view, as autk-map's own
    // tilt leaves it. autk-map's pan, tilt and zoom at the cursor move along it and take it to be across the line of
    // sight; a horizontal one is not, beyond a pitch of 0. The view itself is the same either way.
    const up = [Math.cos(pitch) * Math.sin(bearing), Math.cos(pitch) * Math.cos(bearing), Math.sin(pitch)];
    view.resetCamera(up, [x, y, 0], eye);
}

/**
 * Raises the map's ground to the heights of a raster band, through autk-map's `enableTerrainMode`, once its layers are
 * loaded. autk-map drapes the flat layers over the ground the raster covers and fits the view to it. It refuses a
 * `dataRef` that names no raster table of the map's workspace, and a `band` that names none of several bands.
 */
async function loadTerrain(map: AutkMap, context: AutkDb, terrain: TerrainSpec, index: number): Promise<void> {
    const refuse = (message: string) => new Error(`Map ${index}: terrain ${message}`);
    const table = context.getTablesMetadata().find((candidate) => candidate.name === terrain.dataRef);
    if (!table)
        throw refuse(`dataRef "${terrain.dataRef}" names no table of the map's workspace.`);
    if (table.type !== 'raster')
        throw refuse(`dataRef "${terrain.dataRef}" names a ${table.type ?? 'plain'} table, and a terrain takes its heights from a raster table, such as a geotiff source's.`);
    const collection = await context.getRaster(terrain.dataRef) as unknown as FeatureCollection;
    const band = rasterBand(collection, terrain.band, (message) => refuse(`band ${message}`));
    try {
        map.enableTerrainMode(collection, band);
    } catch (error) {
        throw refuse(`"${terrain.dataRef}": ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * The key of the row a vector layer draws at each of its positions. autk-map draws each feature it is handed as one
 * component, in order, and none for a feature with nothing to draw; a component names its feature by its index among
 * those handed (`featureIndex`). `kept` gives the table row of each feature handed, and `keys` each table row's key.
 */
function drawnRowKeys(map: AutkMap, layerId: string, keys: readonly string[], kept: readonly number[]): string[] {
    const layer = map.layerManager.searchByLayerId(layerId) as unknown as { components?: Array<{ featureIndex?: number }> } | null;
    const components = layer?.components;
    if (!Array.isArray(components)) return kept.map((row) => keys[row] ?? '');
    return components.map((component, position) => {
        const handed = Number.isInteger(component?.featureIndex) ? component.featureIndex! : position;
        return keys[kept[handed]] ?? '';
    });
}

/**
 * The map adapter `AutkGrammar` runs. Each map it draws goes in `maps` at its index, and each of its layers in `layers`,
 * with the rows it draws, so every map stays known, though several draw one table. A table's export is taken once a
 * run, in `exports`, which the plot adapter reads too.
 */
export function createMapAdapter(targets?: Targets, layers?: DrawnLayers, computeCache?: ComputeCache, maps?: AutkMap[], computeTypes?: ComputeLayerTypes, exports?: LayerExports): MapAdapter {

    /** Loads each layer of `spec` on `map`, and gives the keys of the rows each draws, in the order of the layers. */
    async function loadLayers(map: AutkMap, context: AutkDb, spec: MapSpec): Promise<string[][]> {
        let tableToTypeMap: {[tableName: string]: string} = {};
        for(const table of context.getTablesMetadata()) {
            if(table.type !== undefined) tableToTypeMap[table.name] = table.type;
        }

        const drawn: string[][] = [];
        for(const layerRef of spec.layerRefs){
            const name     = layerRef.dataRef;
            const layerId  = layerIdOf(layerRef);
            const key      = tableKey(spec.workspace, name);
            const type     = drawnType(layerRef, (computeTypes?.get(key) ?? tableToTypeMap[name]) as LayerType | undefined, layerId);
            const getFnv   = layerRef.getFnv;

            const rawData = computeCache?.get(key) ?? (type === 'raster'
                ? await context.getRaster(name) as unknown as FeatureCollection
                : await exportOf(exports, exportKey(key, layerRef.osmElements), () => context.getLayer(name, exportOptions(layerRef.osmElements))));
            // Raster tables (e.g. heatmaps) are a single feature with no geometry, so keep them as-is. A vector layer
            // is handed the rows with a geometry: `kept` holds the table row of each.
            const rows = rawData.features ?? [];
            const kept = type === 'raster' ? [] : rows.flatMap((feature, row) => (feature?.geometry != null ? [row] : []));
            const data = type === 'raster' ? rawData : { ...rawData, features: kept.map((row) => rows[row]) };
            const band = type === 'raster'
                ? rasterBand(data, getFnv, (message) => new Error(`Layer "${layerId}": getFnv ${message}`))
                : '';

            if(type === 'raster') {
                map.loadCollection(layerId, { collection: data, type: 'raster', property: band });
            } else {
                // autk-map leaves out a building part without a height, unless it is told to give each a random one.
                const zeroHeight = type === 'buildings' && layerRef.buildingsZeroHeight === true;
                map.loadCollection(layerId, { collection: data, type, ...(zeroHeight ? { loadConfig: { buildingsZeroHeight: true } } : {}) });
            }

            if(layerRef.opacity != null)
                map.updateRenderInfo(layerId, { opacity: layerRef.opacity });

            const style = styleRenderInfo(layerRef, layerId);
            if(Object.keys(style).length > 0)
                map.updateRenderInfo(layerId, style);

            // pointSize is in meters on the ground, and autk-map's in planar units, which Mercator stretches away
            // from the equator: the layer's points are sized at the middle of its extent.
            const crs = context.getWorkspaceConfiguration().coordinateFormat;
            const pointSize = planarPointSize(layerRef.pointSize, type, crs, () => extentOf(data));
            if(pointSize !== undefined)
                map.updateRenderInfo(layerId, { pointSize });

            // Thematic (getFnv) vector layers are colored by value out of the box: autk-map
            // attaches a default colour ramp to every layer, so this works even when the
            // spec omits colorMapInterpolator (see colorsByValue).
            if(colorsByValue(layerRef, type))
                map.updateRenderInfo(layerId, { isColorMap: true });

            if(layerRef.isPick)
                map.updateRenderInfo(layerId, { isPick: true });

            if(layerRef.isSkip)
                map.updateRenderInfo(layerId, { isSkip: true });

            // When catchAllCategory is set, remap features whose property value is not
            // in colorMapDomain to the catch-all label, and extend the domain to include it.
            const { catchAllCategory, colorMapDomain } = layerRef;
            let thematicData = data;
            let effectiveDomain = colorMapDomain;

            if(getFnv && catchAllCategory && colorMapDomain?.length) {
                const allowed = new Set(colorMapDomain);
                thematicData = {
                    ...data,
                    features: data.features.map((f: any) => {
                        const props = f.properties as Record<string, unknown>;
                        const val = valueAtPath(props, getFnv);
                        if(val === undefined || val === null || !allowed.has(String(val))) {
                            return { ...f, properties: setValueAtPath(props, getFnv, catchAllCategory) };
                        }
                        return f;
                    }),
                };
                effectiveDomain = allowed.has(catchAllCategory)
                    ? colorMapDomain
                    : [...colorMapDomain, catchAllCategory];
            }

            // A raster's transfer function is only stored by setTransferFunction; the
            // updateColorMap below colors the cells again with it.
            const rasterTransfer = type === 'raster' && layerRef.transferFunction != null;
            if(rasterTransfer) {
                const layer = map.layerManager.searchByLayerId(layerId) as unknown as
                    { setTransferFunction?: (transferFunction: TransferFunction) => void } | null;
                layer?.setTransferFunction?.(layerRef.transferFunction as TransferFunction);
            }

            // The scheme and its domain go through updateColorMap, which colors a raster's
            // cells again and gives the legend its labels. A vector layer keeps the domain
            // in its config, where the updateThematic below reads it.
            const range = layerRef.colorMapRange;
            const rasterScale = type === 'raster' && (range != null || layerRef.colorMapCenter != null || layerRef.colorMapReverse === true);
            if(layerRef.colorMapInterpolator || rasterScale || range) {
                const colormapConfig: ColorMapConfig = {
                    // urban-grammar ColorMapInterpolator values are string-compatible
                    // with autk-core ColorMapInterpolator at runtime
                    interpolator: (layerRef.colorMapInterpolator as unknown as ColorMapConfig['interpolator'] | undefined)
                        ?? map.layerManager.searchByLayerId(layerId)?.layerRenderInfo.colormap.config.interpolator
                        ?? ColorMapInterpolator.SEQ_REDS,
                    domainSpec: buildDomainSpec(layerRef.normalization, effectiveDomain),
                };
                let domain: number[] | undefined;
                if(rasterScale)
                    domain = rasterScaleDomain(bandValues(data, band), colormapConfig, layerRef.colorMapCenter, layerRef.colorMapReverse, range);
                else if(type !== 'raster')
                    domain = vectorScaleDomain(colormapConfig, range);
                if(domain)
                    colormapConfig.domainSpec = { type: ColorMapDomainStrategy.USER, params: domain };
                map.updateColorMap(layerId, { colorMap: colormapConfig });
            } else if(rasterTransfer) {
                map.updateColorMap(layerId, { colorMap: {} });
            }

            if(getFnv && type !== 'raster') {
                const property = getFnv.startsWith('properties.') ? getFnv : `properties.${getFnv}`;
                map.updateThematic(layerId, { collection: thematicData, property });
            }

            const drawnRows = type === 'raster' ? [] : drawnRowKeys(map, layerId, rowKeys(rows), kept);
            // The run highlights pickedComps once the plots and links exist (see AutkGrammar).
            if(layerRef.pickedComps)
                checkDrawnPositions(layerRef.pickedComps, 'pickedComps', layerId, type, drawnRows.length);
            if(layerRef.skippedComps) {
                checkDrawnPositions(layerRef.skippedComps, 'skippedComps', layerId, type, drawnRows.length);
                // AutkMap.setSkippedIds passes over a points layer, which hides features of its own: the layer's own call
                // hides them on every type of layer.
                map.layerManager.searchByLayerId(layerId)?.setSkippedIds(layerRef.skippedComps);
            }
            drawn.push(drawnRows);
        }
        return drawn;
    }

    return {
        async resolveMap(context: AutkDb | undefined, spec: MapSpec, index: number = 0): Promise<void> {
            if(targets && targets.map && context){

                checkLayerIds(spec, index);
                for(const layerRef of spec.layerRefs) {
                    checkColorMapRange(layerRef);
                    checkPointSize(layerRef.pointSize, layerIdOf(layerRef));
                    if(layerRef.skippedComps !== undefined)
                        checkPositions(layerRef.skippedComps, 'skippedComps', layerIdOf(layerRef));
                }
                checkPickedComps(spec);
                checkMapColors(spec, index);
                // Refused before the map is made, so a refused camera leaves nothing on the page.
                const refusedCamera = spec.camera && cameraRefusal(spec.camera);
                if(refusedCamera)
                    throw new Error(`Map ${index}: ${refusedCamera}`);

                let canvas;

                if(Array.isArray(targets.map)){
                    canvas = document.getElementById(targets.map[index]);
                }else{
                    canvas = document.getElementById(targets.map);
                }

                if(!canvas)
                    throw new Error("Could not find rendering target for map: "+targets.map);

                if(!(canvas instanceof HTMLCanvasElement))
                    throw new Error("Target for map is not a canvas: "+targets.map);

                // autk-map builds its floating menu and legend as the map starts, unless it is told not to.
                const map = spec.showUi === false ? new AutkMap(canvas, false) : new AutkMap(canvas);

                // A map is known to the grammar, which destroys it, once its layers are loaded. One that fails before
                // is destroyed here, so its controls, event handlers and GPU buffers do not outlive the failed run.
                let drawn: string[][];
                try {
                    applyMapColors(map, spec);

                    await map.init();
                    await enterWorkspace(context, spec.workspace);
                    drawn = await loadLayers(map, context, spec);
                    if(spec.terrain)
                        await loadTerrain(map, context, spec.terrain, index);
                } catch(error) {
                    try {
                        map.destroy();
                    } catch {
                        // The run reports the load's error, not the teardown's.
                    }
                    throw error;
                }

                const mapId = mapIdOf(spec, index);
                spec.layerRefs.forEach((layerRef, at) => layers?.push({
                    map, mapIndex: index, mapId, layerId: layerIdOf(layerRef), dataRef: layerRef.dataRef, rows: drawn[at],
                }));

                if(maps)
                    maps[index] = map;

                if(spec.camera)
                    applyCamera(map, spec.camera);

                map.draw();
            }
        }
    }
}
