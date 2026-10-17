import { MapAdapter, MapLayerSpec, MapSpec, NormalizationMode } from '@urban-toolkit/the-urban-grammar';
import { Targets, MapRegistry, MapLayerIds, ComputeCache } from '../types';
import { AutkMap } from '@urban-toolkit/autk-map';
import type { LayerRenderInfo } from '@urban-toolkit/autk-map';
import { ColorMap, ColorMapDomainStrategy, ColorMapInterpolator } from '@urban-toolkit/autk-core';
import type { ColorHEX, ColorMapConfig, ColorMapDomainSpec, ColorRGB, LayerType, TransferFunction } from '@urban-toolkit/autk-core';
import { AutkDb } from '@urban-toolkit/autk-db';

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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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
    if (!Array.isArray(range) || range.length !== 2 || !range.every((value) => typeof value === 'number' && Number.isFinite(value)))
        throw refuse('colorMapRange must hold two numbers, [low, high].');
    const [low, high] = range as [number, number];
    if (low >= high)
        throw refuse(`colorMapRange low (${low}) must be less than high (${high}).`);
    if (layerRef.colorMapDomain !== undefined)
        throw refuse('set colorMapRange or colorMapDomain, not both.');
    const center = layerRef.colorMapCenter;
    if (center != null && (center < low || center > high))
        throw refuse(`colorMapCenter (${center}) must lie within colorMapRange [${low}, ${high}].`);
}

function buildDomainSpec(
    normalization: MapSpec['layerRefs'][number]['normalization'],
    colorMapDomain?: string[],
): ColorMapDomainSpec {
    if (colorMapDomain && colorMapDomain.length > 0)
        return { type: ColorMapDomainStrategy.USER, params: colorMapDomain };
    if (normalization?.mode === NormalizationMode.PERCENTILE) {
        const hasExplicitBounds =
            normalization.lowerPercentile !== undefined || normalization.upperPercentile !== undefined;
        if (hasExplicitBounds)
            return {
                type: ColorMapDomainStrategy.PERCENTILE,
                params: [normalization.lowerPercentile ?? 0, normalization.upperPercentile ?? 100],
            };
        return { type: ColorMapDomainStrategy.PERCENTILE };
    }
    return { type: ColorMapDomainStrategy.MIN_MAX };
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
 * Resolves a grammar value path such as `count.noise` to the raster band that holds it.
 * autk-db stores heatmap values in bands (`band_1`, ...) labelled `<aggregateFn>_<table>`.
 */
function rasterBand(collection: { features?: { properties?: unknown }[] }, getFnv?: string): string {
    const props = collection.features?.[0]?.properties as { bands?: { id: string; label?: string }[] } | undefined;
    const bands = props?.bands ?? [];
    const band = bands.find((b) => b.id === getFnv || b.label === getFnv?.replace(/\./g, '_'));
    return band?.id ?? bands[0]?.id ?? getFnv ?? '';
}

export function createMapAdapter(targets?: Targets, registry?: MapRegistry, computeCache?: ComputeCache, maps?: AutkMap[], layerIds?: MapLayerIds): MapAdapter {

    async function loadLayers(map: AutkMap, context: AutkDb, spec: MapSpec): Promise<void> {
        let tableToTypeMap: {[tableName: string]: string} = {};
        for(const table of context.getTablesMetadata()) {
            if(table.type !== undefined) tableToTypeMap[table.name] = table.type;
        }

        for(const layerRef of spec.layerRefs){
            const name     = layerRef.dataRef;
            const layerId  = layerIdOf(layerRef);
            const type     = tableToTypeMap[name] as LayerType;
            const getFnv   = layerRef.getFnv;

            const rawData = computeCache?.get(name) ?? await context.getLayer(name);
            // Raster tables (e.g. heatmaps) are a single feature with no geometry, so keep them as-is.
            const data = type === 'raster' ? rawData : {
                ...rawData,
                features: (rawData.features ?? []).filter((f: any) => f.geometry != null),
            };
            const band = type === 'raster' ? rasterBand(data, getFnv) : '';

            if(type === 'raster') {
                map.loadCollection(layerId, { collection: data, type: 'raster', property: band });
            } else {
                map.loadCollection(layerId, { collection: data, type });
            }

            if(layerRef.opacity != null)
                map.updateRenderInfo(layerId, { opacity: layerRef.opacity });

            const style = styleRenderInfo(layerRef, layerId);
            if(Object.keys(style).length > 0)
                map.updateRenderInfo(layerId, style);

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
        }
    }

    return {
        async resolveMap(context: AutkDb | undefined, spec: MapSpec, index: number = 0): Promise<void> {
            if(targets && targets.map && context){

                checkLayerIds(spec, index);
                for(const layerRef of spec.layerRefs)
                    checkColorMapRange(layerRef);

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

                const map = new AutkMap(canvas);

                if(spec.style)
                    map.style.setPredefinedStyle(spec.style)

                await map.init();
                await loadLayers(map, context, spec);

                for(const layerRef of spec.layerRefs) {
                    registry?.set(layerRef.dataRef, map);
                    layerIds?.set(layerRef.dataRef, layerIdOf(layerRef));
                }

                if(maps)
                    maps[index] = map;

                map.draw();
            }
        }
    }
}
