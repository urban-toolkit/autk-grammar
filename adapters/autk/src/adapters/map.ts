import { MapAdapter, MapSpec, NormalizationMode } from '@urban-toolkit/the-urban-grammar';
import { Targets, MapRegistry, ComputeCache } from '../types';
import { AutkMap } from '@urban-toolkit/autk-map';
import { ColorMapDomainStrategy } from '@urban-toolkit/autk-core';
import type { ColorMapConfig, ColorMapDomainSpec, LayerType } from '@urban-toolkit/autk-core';
import { AutkDb } from '@urban-toolkit/autk-db';

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

export function createMapAdapter(targets?: Targets, registry?: MapRegistry, computeCache?: ComputeCache): MapAdapter {

    async function loadLayers(map: AutkMap, context: AutkDb, spec: MapSpec): Promise<void> {
        let tableToTypeMap: {[tableName: string]: string} = {};
        for(const table of context.getTablesMetadata()) {
            if(table.type !== undefined) tableToTypeMap[table.name] = table.type;
        }

        for(const layerRef of spec.layerRefs){
            const name     = layerRef.dataRef;
            const type     = tableToTypeMap[name] as LayerType;
            const getFnv   = layerRef.getFnv;

            const rawData = computeCache?.get(name) ?? await context.getLayer(name);
            // Raster tables (e.g. heatmaps) are a single feature with no geometry, so keep them as-is.
            const data = type === 'raster' ? rawData : {
                ...rawData,
                features: (rawData.features ?? []).filter((f: any) => f.geometry != null),
            };

            if(type === 'raster') {
                map.loadCollection(name, { collection: data, type: 'raster', property: rasterBand(data, getFnv) });
            } else {
                map.loadCollection(name, { collection: data, type });
            }

            if(layerRef.opacity != null)
                map.updateRenderInfo(name, { opacity: layerRef.opacity });

            // Enable the colormap by default for thematic (getFnv) vector layers so
            // autk-grammar maps render coloured-by-value out of the box. autk-map
            // attaches a default colour ramp to every layer, so this works even when
            // the spec omits colorMapInterpolator. Callers can still opt out by
            // setting isColorMap: false explicitly. Raster layers manage their own ramp.
            const enableColorMap = layerRef.isColorMap ?? (getFnv != null && type !== 'raster');
            if(enableColorMap)
                map.updateRenderInfo(name, { isColorMap: true });

            if(layerRef.isPick)
                map.updateRenderInfo(name, { isPick: true });

            if(layerRef.isSkip)
                map.updateRenderInfo(name, { isSkip: true });

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

            if(layerRef.colorMapInterpolator) {
                const colormapConfig: ColorMapConfig = {
                    // urban-grammar ColorMapInterpolator values are string-compatible
                    // with autk-core ColorMapInterpolator at runtime
                    interpolator: layerRef.colorMapInterpolator as unknown as ColorMapConfig['interpolator'],
                    domainSpec: buildDomainSpec(layerRef.normalization, effectiveDomain),
                };
                map.updateRenderInfo(name, { colormap: { config: colormapConfig }, isColorMap: true });
            }

            if(getFnv && type !== 'raster') {
                const property = getFnv.startsWith('properties.') ? getFnv : `properties.${getFnv}`;
                map.updateThematic(name, { collection: thematicData, property });
            }
        }
    }

    return {
        async resolveMap(context: AutkDb | undefined, spec: MapSpec, index: number = 0): Promise<void> {
            if(targets && targets.map && context){

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

                if(registry)
                    for(const layerRef of spec.layerRefs)
                        registry.set(layerRef.dataRef, map);

                map.draw();
            }
        }
    }
}
