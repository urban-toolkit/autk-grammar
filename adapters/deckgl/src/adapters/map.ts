import type { FeatureCollection, Feature, GeoJSON } from 'geojson';
import type { MapAdapter, MapSpec } from '@urban-toolkit/the-urban-grammar';
import { NormalizationMode, ColorMapInterpolator } from '@urban-toolkit/the-urban-grammar';
import { Deck, GeoJsonLayer, TileLayer, BitmapLayer } from 'deck.gl';
import type { Color } from 'deck.gl';
import { DeckGlDb, DeckRegistry, Targets } from '../types';
import { sequentialColor, categoricalColor, isCategoricalScale, type RGBA } from '../utils/color';
import { computeViewState, getNestedValue, computePercentile } from '../utils/geo';

type LayerRef = MapSpec['layerRefs'][number];

function buildColorAccessor(
    collection: FeatureCollection,
    ref: LayerRef,
): ((feature: Feature) => Color) | Color {
    const { getFnv, getFnvType, colorMapInterpolator, normalization, colorMapDomain, opacity } = ref;
    const alpha = Math.round((opacity ?? 1) * 255);

    if (!getFnv || !colorMapInterpolator) {
        return [100, 100, 100, alpha];
    }

    const isCat = getFnvType === 'categorical' || isCategoricalScale(colorMapInterpolator);

    if (isCat) {
        const categories: string[] = colorMapDomain
            ? [...colorMapDomain]
            : Array.from(new Set(
                collection.features.map(f => String(getNestedValue(f.properties ?? {}, getFnv))),
            ));

        return (feature: Feature): Color => {
            const val = String(getNestedValue(feature.properties ?? {}, getFnv));
            const idx = categories.indexOf(val);
            const [r, g, b] = categoricalColor(colorMapInterpolator, idx < 0 ? 0 : idx);
            return [r, g, b, alpha];
        };
    }

    // Quantitative
    const rawValues = collection.features
        .map(f => {
            const v = getNestedValue(f.properties ?? {}, getFnv);
            return typeof v === 'number' ? v : parseFloat(String(v));
        })
        .filter(v => !isNaN(v));

    let min: number;
    let max: number;

    if (normalization?.mode === NormalizationMode.PERCENTILE) {
        min = computePercentile(rawValues, normalization.lowerPercentile ?? 0);
        max = computePercentile(rawValues, normalization.upperPercentile ?? 100);
    } else {
        min = Math.min(...rawValues);
        max = Math.max(...rawValues);
    }

    const range = max - min || 1;

    return (feature: Feature): Color => {
        const v = getNestedValue(feature.properties ?? {}, getFnv);
        const num = typeof v === 'number' ? v : parseFloat(String(v));
        const t = isNaN(num) ? 0 : Math.max(0, Math.min(1, (num - min) / range));
        const [r, g, b] = sequentialColor(colorMapInterpolator, t);
        return [r, g, b, alpha];
    };
}

function applyDefaultFnv(collection: FeatureCollection, ref: LayerRef): FeatureCollection {
    if (!ref.defaultFnv || !ref.getFnv) return collection;
    return {
        ...collection,
        features: collection.features.map(f => {
            const props = f.properties ?? {};
            const val = getNestedValue(props, ref.getFnv!);
            if (val !== undefined && val !== null) return f;
            const keys = ref.getFnv!.split('.');
            const updated = { ...props };
            let cur = updated as Record<string, unknown>;
            for (let i = 0; i < keys.length - 1; i++) {
                cur[keys[i]] = { ...(cur[keys[i]] as Record<string, unknown> ?? {}) };
                cur = cur[keys[i]] as Record<string, unknown>;
            }
            cur[keys[keys.length - 1]] = ref.defaultFnv;
            return { ...f, properties: updated };
        }),
    };
}

function buildDeckLayer(id: string, collection: FeatureCollection, ref: LayerRef): GeoJsonLayer {
    const getFillColor = buildColorAccessor(collection, ref);
    const opacity = ref.opacity ?? 1;

    return new GeoJsonLayer({
        id,
        data: collection as GeoJSON,
        pickable: ref.isPick ?? false,
        opacity,
        filled: true,
        stroked: true,
        getFillColor,
        getLineColor: [80, 80, 80, Math.round(opacity * 200)] as RGBA,
        getLineWidth: 1,
        lineWidthMinPixels: 1,
        pointRadiusMinPixels: 4,
        autoHighlight: ref.isPick ?? false,
    });
}

function buildTileLayer(): TileLayer {
    return new TileLayer({
        id: 'osm-background',
        data: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxZoom: 19,
        minZoom: 0,
        renderSubLayers: (props) => {
            const { west, south, east, north } = props.tile.bbox as { west: number; south: number; east: number; north: number };
            return new BitmapLayer({
                ...props,
                data: undefined,
                image: props.data as ImageBitmap,
                bounds: [west, south, east, north],
            });
        },
    });
}

export function createMapAdapter(targets?: Targets, registry?: DeckRegistry): MapAdapter {
    return {
        async resolveMap(context: unknown, spec: MapSpec, index: number = 0): Promise<void> {
            if (!targets?.map || !context) return;

            const targetId = Array.isArray(targets.map) ? targets.map[index] : targets.map;
            const el = document.getElementById(targetId);
            if (!el) throw new Error(`Map target not found: ${targetId}`);

            const db = context as DeckGlDb;

            const collections = spec.layerRefs
                .filter(ref => !ref.isSkip)
                .map(ref => db.get(ref.dataRef))
                .filter((fc): fc is FeatureCollection => fc !== undefined);

            const viewState = computeViewState(collections);

            const dataLayers = spec.layerRefs
                .filter(ref => !ref.isSkip)
                .map(ref => {
                    const raw = db.get(ref.dataRef);
                    if (!raw) return null;
                    const fc = applyDefaultFnv(raw, ref);
                    return buildDeckLayer(ref.dataRef, fc, ref);
                })
                .filter((l): l is GeoJsonLayer => l !== null);

            const deck = new Deck({
                parent: el as HTMLDivElement,
                initialViewState: {
                    ...viewState,
                    pitch: 0,
                    bearing: 0,
                },
                controller: true,
                layers: [buildTileLayer(), ...dataLayers],
            });

            if (registry) {
                for (const ref of spec.layerRefs) {
                    registry.set(ref.dataRef, deck);
                }
            }
        },
    };
}

// Re-export ColorMapInterpolator so callers can reference it without importing grammar directly
export { ColorMapInterpolator };
