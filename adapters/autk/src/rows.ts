import type { Feature } from 'geojson';

/**
 * A selection passes between a plot and a map layer by the rows each drew, not by positions. A plot draws its table's
 * rows in the order the host handed them, while a map layer draws autk-db's export of the table, which can keep the
 * rows in an order of its own and leaves out those without a geometry, so one position can be another row in each
 * view. Each row is known in both by its feature id, which autk-db keeps in its export. Nothing here needs a GPU or a
 * database, so the unit tests run it in Node.
 */

/**
 * The id autk-db gives each feature of a GeoJSON source: its own `id`, else `autk-feature-<index>`, with `-generated`
 * added while another feature has that id. The data adapter hands autk-db features that carry these ids, so autk-db
 * keeps them in its export whatever rule it would use itself.
 */
export function featureIds(features: readonly (Feature | null | undefined)[]): Array<string | number> {
    const own = new Set<string>();
    for (const feature of features) {
        if (feature?.id != null) own.add(JSON.stringify(feature.id));
    }
    const given = new Set<string>();
    return features.map((feature, index) => {
        if (feature?.id != null) return feature.id;
        let id = `autk-feature-${index}`;
        while (own.has(JSON.stringify(id)) || given.has(JSON.stringify(id))) id = `${id}-generated`;
        given.add(JSON.stringify(id));
        return id;
    });
}

/**
 * The key of each row of a collection, which names the row in every view of its table: its id as {@link featureIds}
 * gives it, written as JSON so that `3` and `"3"` stay apart, and the times that id came before when it repeats.
 */
export function rowKeys(features: readonly (Feature | null | undefined)[]): string[] {
    const seen = new Map<string, number>();
    return featureIds(features).map((id) => {
        const json = JSON.stringify(id);
        const before = seen.get(json) ?? 0;
        seen.set(json, before + 1);
        return before === 0 ? json : `${json} ${before}`;
    });
}

/** Each key's positions, built once for each list of keys. */
const positionsByKey = new WeakMap<readonly string[], Map<string, number[]>>();

function positionsOf(keys: readonly string[]): Map<string, number[]> {
    let positions = positionsByKey.get(keys);
    if (positions) return positions;
    positions = new Map();
    keys.forEach((key, position) => {
        const list = positions!.get(key);
        if (list) list.push(position);
        else positions!.set(key, [position]);
    });
    positionsByKey.set(keys, positions);
    return positions;
}

/**
 * The positions in one view of the rows at the positions `ids` in another, each view given by the key of the row at
 * each of its positions. A row the other view does not draw has no position there, and a row it draws at several
 * positions has each of them.
 */
export function translateIds(ids: readonly number[], from: readonly string[], to: readonly string[]): number[] {
    const positions = positionsOf(to);
    const translated = new Set<number>();
    for (const id of ids) {
        const key = from[id];
        if (key === undefined) continue;
        for (const position of positions.get(key) ?? []) translated.add(position);
    }
    return [...translated];
}
