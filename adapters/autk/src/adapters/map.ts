import type { FeatureCollection } from 'geojson';
import { MapAdapter, MapLayerSpec, MapSpec, CameraSpec, TerrainSpec } from '@urban-toolkit/the-urban-grammar';
import { enterWorkspace, tableKey } from '../workspace';
import { Targets, ComputeCache, ComputeLayerTypes } from '../types';
import { DrawnLayers, LayerExports, exportKey, exportOf, exportOptions, mapIdOf, osmElementsOf } from '../drawn';
import { rowKeys } from '../rows';
import { AutkMap } from '@urban-toolkit/autk-map';
import type { LayerRenderInfo, MapStyleShape } from '@urban-toolkit/autk-map';
// A path is read as autk-map reads getFnv: key by key, else as a key with dots in it, such as a join's `<table>.<column>`.
import { ColorMap, ColorMapDomainStrategy, ColorMapInterpolator, valueAtPath } from '@urban-toolkit/autk-core';
import type { ColorHEX, ColorMapConfig, ColorRGB, LayerType, TransferFunction } from '@urban-toolkit/autk-core';
import { AutkDb } from '@urban-toolkit/autk-db';
import { extentOf } from './data';
import { checkPointSize, planarPointSize } from '../point-size';
import { HEX_COLOR, buildDomainSpec, colorMapRangeRefusal } from '../color-keys';
import { centerOnMap, centerRefusal, groundHeight, keepTerrainGround, motionRefusal, playCameraMotion, resolveCameraCenter } from '../camera';

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
 * either way, and this only shows or hides its legend, which a scale of its own or `legend` shows. Otherwise a layer
 * with a `color` is drawn in it, and a layer with a scheme or a `getFnv` value is colored by value.
 */
function colorsByValue(layerRef: MapLayerSpec, type: LayerType): boolean {
    if (layerRef.isColorMap != null) return layerRef.isColorMap;
    if (type === 'raster')
        return layerRef.colorMapInterpolator != null || layerRef.colorMapRange != null || layerRef.colorMapCenter != null
            || layerRef.colorMapReverse === true || layerRef.legend === true;
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
 * Whether a color map config's scheme is categorical. autk-core 4.1.1 gives every config an interpolator. On Autark's
 * main a config can also be made of colors alone, with no interpolator and a `type` that says whether it is
 * categorical, so both are read here.
 */
function isCategoricalConfig(config: ColorMapConfig): boolean {
    if (config.interpolator !== undefined) return ColorMap.isCategorical(config.interpolator);
    return (config as unknown as { type?: string }).type === 'categorical';
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
    if (isCategoricalConfig(config)) return undefined;
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
    if (range == null || isCategoricalConfig(config)) return undefined;
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

/** Refuses a `widthBy` that is not a path, and one set with `width`, which gives every line one width. */
function checkWidthBy(layerRef: MapLayerSpec, layerId: string): void {
    const path: unknown = layerRef.widthBy;
    if (path === undefined) return;
    if (typeof path !== 'string' || path === '')
        throw new Error(`Layer "${layerId}": widthBy must be the dot path to each line's width, not ${JSON.stringify(path)}.`);
    if (layerRef.width !== undefined)
        throw new Error(`Layer "${layerId}": set width or widthBy, not both: width gives every line one width.`);
}

/**
 * Sets the width of each line of a roads layer from the property `widthBy` names, as autk-map's widths by feature
 * (`polylinesWidthByComponent`): a line without a positive number there keeps the width autk-map gave its kind of road.
 * autk-map gives every polylines layer one width, which wins over widths by feature and which a layer cannot clear, so
 * only a roads layer takes it.
 */
function applyWidthBy(map: AutkMap, layerId: string, path: string, type: LayerType, data: FeatureCollection): void {
    if (type !== 'roads')
        throw new Error(`Layer "${layerId}": widthBy sets the width of each line of a roads layer, and the layer is drawn as ${type}: draw a table of lines as roads with layerType: 'roads'.`);
    const layer = map.layerManager.searchByLayerId(layerId) as unknown as
        { components?: Array<{ featureIndex?: number }>; layerRenderInfo: LayerRenderInfo } | null;
    const components = layer?.components ?? [];
    const widths = new Float32Array(components.length);
    widths.set(layer?.layerRenderInfo.polylinesWidthByComponent?.subarray(0, components.length) ?? []);
    const relative = path.startsWith('properties.') ? path.slice('properties.'.length) : path;
    let given = 0;
    components.forEach((component, position) => {
        const feature = data.features[component.featureIndex ?? position];
        const width = Number(valueAtPath(feature?.properties, relative));
        if (Number.isFinite(width) && width > 0) {
            widths[position] = width;
            given++;
        }
    });
    if (given === 0)
        throw new Error(`Layer "${layerId}": widthBy "${path}" gives no line of the layer a width: none has a positive number there.`);
    map.updateRenderInfo(layerId, { polylinesWidthByComponent: widths });
}

/** Refuses `legend` on two layers of a map, which shows one legend, and on a map whose `showUi` hides its legend. */
function checkLegend(spec: MapSpec, index: number): void {
    const legends = spec.layerRefs.filter((layerRef) => layerRef.legend === true).map(layerIdOf);
    if (legends.length > 1)
        throw new Error(`Map ${index}: layers ${legends.map((id) => `"${id}"`).join(' and ')} each set legend: a map shows one legend.`);
    if (legends.length === 1 && spec.showUi === false)
        throw new Error(`Layer "${legends[0]}": legend shows the layer in the map's legend, and the map's showUi is false, which hides the legend.`);
}

/**
 * Shows the color scale of the layer that sets `legend` in the map's legend, which otherwise shows the last layer whose
 * colors autk-map set. It sets the legend's layer alone, through the map UI's `activeLayer`: autk-map's
 * `changeActiveLayer` would also make that layer the only one of the map that picks. It refuses a layer drawn in one color.
 */
function showLegendOf(map: AutkMap, spec: MapSpec): void {
    const layerRef = spec.layerRefs.find((candidate) => candidate.legend === true);
    if (!layerRef) return;
    const layerId = layerIdOf(layerRef);
    const layer = map.layerManager.searchByLayerId(layerId);
    if (!layer?.layerRenderInfo.isColorMap)
        throw new Error(`Layer "${layerId}": legend shows the color scale of a layer colored by value, and the layer is drawn in one color.`);
    map.ui.activeLayer = layer;
    map.ui.refreshLegend(null);
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

/**
 * Why the map has no layer of a layer of the spec, autk-map having been handed `count` features for it: autk-map logs
 * such a layer and goes on without it. autk-core 4.1.1 raises a building part only from `height`, `building:height`,
 * `levels` or `building:levels`, to a height above the part's minimum (`TriangulatorBuildings.computeBuildingHeights`),
 * and autk-map makes no buildings layer of features it raises no part of.
 */
function layerNotMade(layerRef: MapLayerSpec, type: LayerType | undefined, count: number): string {
    if (count === 0) return `the table "${layerRef.dataRef}" has no feature to draw, so the map has no layer of it.`;
    const features = `${count} feature${count === 1 ? '' : 's'}`;
    if (type === 'buildings') {
        const remedy = layerRef.buildingsZeroHeight === true
            ? 'Each part has one of them, with a height not above its minimum.'
            : 'Give the features one of those keys, or set buildingsZeroHeight: true to raise each part without them to a random height.';
        return `autk-map drew no building of the ${features} of the table "${layerRef.dataRef}", so the map has no layer of them: `
            + `autk-core raises a building part only from height, building:height, levels or building:levels, to a height above the part's minimum. ${remedy}`;
    }
    if (type === 'raster')
        return `autk-map drew nothing of the raster table "${layerRef.dataRef}", so the map has no layer of it.`;
    return `autk-map drew none of the ${features} of the table "${layerRef.dataRef}"${type ? ` as ${type}` : ''}, so the map has no layer of them.`;
}

/**
 * Leaves out a layer the map has no layer of, as autk-map leaves it out, so the run goes on with the others, as 5.6.0
 * did: it warns why when autk-map was handed features for the layer, and refuses the keys that need the layer, `legend`
 * and `pickedComps`. The run's lookup and its links do not name the layer.
 */
function leaveOut(layerRef: MapLayerSpec, layerId: string, type: LayerType | undefined, count: number): void {
    const cause = layerNotMade(layerRef, type, count);
    const needs = layerRef.legend === true ? 'legend' : layerRef.pickedComps !== undefined ? 'pickedComps' : undefined;
    if (needs)
        throw new Error(`Layer "${layerId}": ${needs} needs the layer, and ${cause}`);
    if (count > 0)
        console.warn(`Layer "${layerId}": ${cause}`);
}

/** Refuses a list of feature positions that is not whole numbers from 0, as `key` of a layer. */
function checkPositions(positions: unknown, key: string, layerId: string): void {
    if (!Array.isArray(positions) || !positions.every((position) => Number.isInteger(position) && position >= 0))
        throw new Error(`Layer "${layerId}": ${key} must list the positions of features the layer draws, whole numbers from 0, not ${JSON.stringify(positions)}.`);
}

/**
 * The positions of the features `layer` hides now, as autk-map's own getters give them: a vector layer's `skippedIds`,
 * and on a points layer, which keeps no such list, each feature whose first point instance its `skippedVertices` hides,
 * its components holding their instances up to a running count, `nPoints`. So the calls that hide and show features,
 * autk-map's `setSkippedIds` and `clearSkippedIds` and the layer's own, a host's after the run included, count.
 */
function hiddenNow(layer: unknown): ReadonlySet<number> {
    const { skippedIds, skippedVertices, components } = (layer ?? {}) as { skippedIds?: unknown; skippedVertices?: unknown; components?: unknown };
    if (Array.isArray(skippedIds)) return new Set(skippedIds as number[]);
    const hidden = new Set<number>();
    if (!ArrayBuffer.isView(skippedVertices) || !Array.isArray(components)) return hidden;
    const vertices = skippedVertices as unknown as ArrayLike<number>;
    const counts = components as Array<{ nPoints?: number } | null>;
    counts.forEach((component, position) => {
        const first = position > 0 ? Number(counts[position - 1]?.nPoints) : 0;
        if (first < Number(component?.nPoints) && vertices[first] > 0) hidden.add(position);
    });
    return hidden;
}

/**
 * The positions of `selection`, picked on the layer `layerId` of `map`, that the layer shows as the pick arrives.
 * autk-map 4.1.1's picking passes draw the hidden features of a points, polygons or buildings layer too, so a pick can
 * find a feature the layer hides: the grammar leaves it out of the picks it forwards and of what it hands the plots
 * linked to the layer.
 */
export function shownPicks(map: AutkMap, layerId: string, selection: number[]): number[] {
    if (selection.length === 0) return selection;
    const hidden = hiddenNow(map.layerManager.searchByLayerId(layerId));
    return hidden.size > 0 ? selection.filter((position) => !hidden.has(position)) : selection;
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
 * Why a run refuses `camera`, or `undefined` when it takes it: a pitch that is not at least 0 and less than 90 degrees,
 * a center that is not `[longitude, latitude]` in degrees, or a motion `motionRefusal` refuses from the view the camera
 * sets. At 90 the eye would sit on the ground, edge-on to the map's flat layers, and autk-map's pan, which moves the eye
 * by its height, would stand still. The schema refuses the same pitches and centers, and the steps of a shape it reads.
 */
function cameraRefusal(camera: CameraSpec): string | undefined {
    const { pitch } = camera as { pitch?: unknown };
    if (pitch === undefined || (typeof pitch === 'number' && pitch >= 0 && pitch < 90))
        return centerRefusal(camera.center) ?? motionRefusal(camera.motion, { tilt: camera.pitch ?? 0, bank: 0 });
    const shown = typeof pitch === 'number' ? String(pitch) : JSON.stringify(pitch);
    return `camera.pitch must be at least 0 and less than 90 degrees, not ${shown}: at 90 the eye would sit on the ground, edge-on to the map's flat layers, and the map could not pan.`;
}

/**
 * Moves a map's camera as `camera` says, from the view that fits the map's layers. The camera reports each change,
 * so the map redraws without a request. It refuses a pitch that is not at least 0 and less than 90 degrees, and a
 * `center` that `resolveCameraCenter` has not put on the map. On a map whose terrain the grammar raised, it looks at
 * the ground, at the terrain's height under the point it looks at, and sets the eye's distance from that point: `zoom`'s,
 * else that of the view that fits the terrain.
 *
 * The map adapter calls it once the map's layers are loaded and before the map's first `draw()`. A host that builds
 * its own map from a spec's `map` entry calls it at the same point, so the map looks from where the grammar's would.
 */
export function applyCamera(map: AutkMap, camera: CameraSpec): void {
    const refused = cameraRefusal(camera);
    if(refused) throw new Error(refused);
    const center = camera.center && centerOnMap(map, camera.center);
    if(camera.zoom === undefined && !camera.pitch && !camera.bearing && !center) return;

    // Turn the view around the point it looks at, `center` or else the one the view looks at now: the eye moves on a
    // sphere around that point, so the data stays in view at any pitch. `pitch` is the angle from straight down and
    // `bearing` the compass heading of the view, clockwise from north.
    const view = map.camera;
    const [x, y] = center ?? view.getLookAt();
    // autk-map draws a terrain at its raw elevation, which can lie kilometres above z = 0: the point looked at is on the
    // ground, and the eye's distance is measured from it. Without zoom, it is the height of the eye of the view this
    // turns, as on a flat map: the view that fits the layers, or the terrain, which autk-map measures from z = 0.
    const ground = groundHeight(map, x, y);
    const distance = camera.zoom !== undefined ? 10000 / Math.pow(2, camera.zoom - 10) : Math.abs(view.getEye()[2]);
    const pitch = (camera.pitch ?? 0) * Math.PI / 180;
    const bearing = (camera.bearing ?? 0) * Math.PI / 180;
    const eye = [
        x - distance * Math.sin(pitch) * Math.sin(bearing),
        y - distance * Math.sin(pitch) * Math.cos(bearing),
        ground + distance * Math.cos(pitch),
    ];
    // The view's up direction: across the line of sight at any pitch, toward the far side of the view, as autk-map's own
    // tilt leaves it. autk-map's pan, tilt and zoom at the cursor move along it and take it to be across the line of
    // sight; a horizontal one is not, beyond a pitch of 0. The view itself is the same either way.
    const up = [Math.cos(pitch) * Math.sin(bearing), Math.cos(pitch) * Math.cos(bearing), Math.sin(pitch)];
    view.resetCamera(up, [x, y, ground], eye);
}

/**
 * Raises the map's ground to the heights of a raster band, through autk-map's `enableTerrainMode`, once its layers are
 * loaded. autk-map drapes the flat layers over the ground the raster covers, and the view is fitted to that ground with
 * autk-map's `resetCamera`, which in terrain mode frames the heights: autk-map 4.1.1 also frames them as it enables the
 * terrain, while Autark's main keeps the view the map's layers set. It refuses a `dataRef` that names no raster table of
 * the map's workspace, and a `band` that names none of several bands.
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
        map.resetCamera();
    } catch (error) {
        throw refuse(`"${terrain.dataRef}": ${error instanceof Error ? error.message : String(error)}`);
    }
    // The ground the map's camera and its tours are measured from.
    keepTerrainGround(map, collection, band);
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
 * Puts the origin of a map whose first layer is a raster at the middle of the raster, before autk-map loads it, so a
 * map that draws a raster alone, such as a heatmap, draws it. autk-map draws every layer of a map from one origin, the
 * middle of the geometries of the first collection it loads. A raster's one feature has no geometry, so autk-map
 * before urban-toolkit/autark#125 (`resolveCollectionBounds`, on autark's main since 11-11, not released) put the
 * origin at [0, 0], thousands of kilometres from the raster, and drew an empty canvas. The raster's `bbox` is handed to
 * autk-map as a polygon, whose middle any autk-map takes as the origin, as #125 takes the raster's own. This can go
 * once the grammar's autk-map has #125.
 */
function setRasterOrigin(map: AutkMap, raster: FeatureCollection): void {
    if(map.layerManager.hasOrigin) return;
    const bbox = raster.bbox;
    if(!bbox) return;
    const [west, south, east, north] = bbox.length === 6 ? [bbox[0], bbox[1], bbox[3], bbox[4]] : [bbox[0], bbox[1], bbox[2], bbox[3]];
    if(![west, south, east, north].every(Number.isFinite)) return;
    map.layerManager.initializeOrigin({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
        }],
    });
}

/**
 * The map adapter `AutkGrammar` runs. Each map it draws goes in `maps` at its index, and each of its layers in `layers`,
 * with the rows it draws, so every map stays known, though several draw one table. A table's export is taken once a
 * run, in `exports`, which the plot adapter reads too.
 */
export function createMapAdapter(targets?: Targets, layers?: DrawnLayers, computeCache?: ComputeCache, maps?: AutkMap[], computeTypes?: ComputeLayerTypes, exports?: LayerExports): MapAdapter {

    /**
     * Loads each layer of `spec` on `map`, and gives, in the order of the layers, the keys of the rows each draws and the
     * collection it handed autk-map for it, or `undefined` for a layer the map has no layer of (see `leaveOut`).
     */
    async function loadLayers(map: AutkMap, context: AutkDb, spec: MapSpec): Promise<Array<{ rows: string[]; collection: FeatureCollection } | undefined>> {
        let tableToTypeMap: {[tableName: string]: string} = {};
        for(const table of context.getTablesMetadata()) {
            if(table.type !== undefined) tableToTypeMap[table.name] = table.type;
        }

        const drawn: Array<{ rows: string[]; collection: FeatureCollection } | undefined> = [];
        for(const layerRef of spec.layerRefs){
            const name     = layerRef.dataRef;
            const layerId  = layerIdOf(layerRef);
            const key      = tableKey(spec.workspace, name);
            // With osmElements, a table a pass changed in place is drawn from autk-db's elements, as autk-db types it.
            const elements = layerRef.osmElements === true && computeCache?.has(key) ? await osmElementsOf(context, name, key, exports) : undefined;
            const type     = drawnType(layerRef, ((elements ? undefined : computeTypes?.get(key)) ?? tableToTypeMap[name]) as LayerType | undefined, layerId);
            const getFnv   = layerRef.getFnv;

            const rawData = elements ?? computeCache?.get(key) ?? (type === 'raster'
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
                setRasterOrigin(map, data);
                map.loadCollection(layerId, { collection: data, type: 'raster', property: band });
            } else {
                // autk-map leaves out a building part without a height, unless it is told to give each a random one.
                const zeroHeight = type === 'buildings' && layerRef.buildingsZeroHeight === true;
                map.loadCollection(layerId, { collection: data, type, ...(zeroHeight ? { loadConfig: { buildingsZeroHeight: true } } : {}) });
            }
            if(!map.layerManager.searchByLayerId(layerId)) {
                leaveOut(layerRef, layerId, type, data.features?.length ?? 0);
                drawn.push(undefined);
                continue;
            }

            if(layerRef.opacity != null)
                map.updateRenderInfo(layerId, { opacity: layerRef.opacity });

            const style = styleRenderInfo(layerRef, layerId);
            if(Object.keys(style).length > 0)
                map.updateRenderInfo(layerId, style);

            if(layerRef.widthBy !== undefined)
                applyWidthBy(map, layerId, layerRef.widthBy, type, data);

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
            drawn.push({ rows: drawnRows, collection: data });
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
                    checkWidthBy(layerRef, layerIdOf(layerRef));
                }
                checkPickedComps(spec);
                checkMapColors(spec, index);
                checkLegend(spec, index);
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
                let drawn: Array<{ rows: string[]; collection: FeatureCollection } | undefined>;
                try {
                    applyMapColors(map, spec);

                    await map.init();
                    await enterWorkspace(context, spec.workspace);
                    drawn = await loadLayers(map, context, spec);
                    if(spec.terrain)
                        await loadTerrain(map, context, spec.terrain, index);
                    showLegendOf(map, spec);
                    // The point the camera looks at, in the CRS of the map's workspace, which is current here.
                    if(spec.camera?.center)
                        await resolveCameraCenter(context, map, spec.camera.center)
                            .catch((error: Error) => { throw new Error(`Map ${index}: ${error.message}`); });
                } catch(error) {
                    try {
                        map.destroy();
                    } catch {
                        // The run reports the load's error, not the teardown's.
                    }
                    throw error;
                }

                const mapId = mapIdOf(spec, index);
                spec.layerRefs.forEach((layerRef, at) => {
                    const loaded = drawn[at];
                    if(loaded) layers?.push({
                        map, mapIndex: index, mapId, layerId: layerIdOf(layerRef), dataRef: layerRef.dataRef,
                        rows: loaded.rows, collection: loaded.collection,
                    });
                });

                if(maps)
                    maps[index] = map;

                if(spec.camera)
                    applyCamera(map, spec.camera);

                map.draw();

                // The camera tour starts from the view just drawn; the run does not wait for it.
                if(spec.camera?.motion?.length)
                    playCameraMotion(map, spec.camera.motion);
            }
        }
    }
}
