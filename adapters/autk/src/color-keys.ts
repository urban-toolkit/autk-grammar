import { NormalizationMode } from '@urban-toolkit/the-urban-grammar';
import type { MapLayerSpec } from '@urban-toolkit/the-urban-grammar';
import { ColorMapDomainStrategy } from '@urban-toolkit/autk-core';
import type { ColorMapDomainSpec } from '@urban-toolkit/autk-core';

/**
 * The color keys a map layer and a plot share, read alike for both: `colorMapRange`, `colorMapDomain` and
 * `normalization`. Nothing here needs a page or a GPU, so the unit tests run it in Node.
 */

/**
 * Why a layer or a plot refuses its `colorMapRange`, or `undefined` when it takes it: a range that is not two numbers
 * with low less than high, or one set with `colorMapDomain`. The schema refuses the same shapes and the pairing, but
 * JSON Schema cannot compare two values: a low above its high is refused only here.
 */
export function colorMapRangeRefusal(range: unknown, colorMapDomain: unknown): string | undefined {
    if (range === undefined) return undefined;
    if (!Array.isArray(range) || range.length !== 2 || !range.every((value) => typeof value === 'number' && Number.isFinite(value)))
        return 'colorMapRange must hold two numbers, [low, high].';
    const [low, high] = range as [number, number];
    if (low >= high)
        return `colorMapRange low (${low}) must be less than high (${high}).`;
    if (colorMapDomain !== undefined)
        return 'set colorMapRange or colorMapDomain, not both.';
    return undefined;
}

/**
 * How autk-core finds the domain of a color scale: the categories `colorMapDomain` names, when it names some; else the
 * percentiles `normalization` gives, 2 and 98 when it gives neither, else 0 and 100 for the one it leaves out; else the
 * lowest and highest values.
 */
export function buildDomainSpec(
    normalization: MapLayerSpec['normalization'],
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
