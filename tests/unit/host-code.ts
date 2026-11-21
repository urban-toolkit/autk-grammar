// Code a host writes against the grammar's types, which host-types.mts compiles: a patch keeps it compiling, as it did
// with 5.6.0. It is never run.
import type { HeatmapSourceSpec, JoinSourceSpec } from '../../grammar/src/types';
import type { HeatmapAggregateFunction } from '../../grammar/src/constants';

type HeatmapEntry = NonNullable<HeatmapSourceSpec['groupBy']>[number];
type JoinEntry = NonNullable<JoinSourceSpec['groupBy']>[number];

/** A heatmap whose aggregate the host's user may leave out, which a run refuses. */
export function heatmapOf(column: string, aggregateFn?: HeatmapAggregateFunction): HeatmapSourceSpec {
    return {
        type: 'heatmap', outputTableName: 'heat', joinDataRef: 'spots', near: { distance: 500 }, grid: { rows: 2, columns: 2 },
        groupBy: [{ column, aggregateFn }],
    };
}

/** Entries a host fills in before its run, a heatmap's as a join's. */
export const entries: [HeatmapEntry, JoinEntry] = [{ column: 'id' }, { column: 'id' }];

/** A heatmap refuses collect, which lists rows while a cell holds one value, and so does its type. */
// @ts-expect-error collect is no aggregate of a heatmap.
export const collected: HeatmapEntry = { column: 'id', aggregateFn: 'collect' };
