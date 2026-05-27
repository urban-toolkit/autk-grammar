import type { FeatureCollection } from 'geojson';
import type { Deck } from 'deck.gl';
import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';

export type Targets = {
    db?: string;
    map?: string[] | string;
    plot?: string;
    compute?: string;
};

export class DeckGlDb {
    private _tables = new Map<string, { data: FeatureCollection; source?: string }>();

    add(name: string, data: FeatureCollection, source?: string): void {
        this._tables.set(name, { data, source });
    }

    get(name: string): FeatureCollection | undefined {
        return this._tables.get(name)?.data;
    }

    has(name: string): boolean {
        return this._tables.has(name);
    }

    get tableNames(): string[] {
        return Array.from(this._tables.keys());
    }
}

export type DeckRegistry = Map<string, Deck>;
export type GeoJsonCache = Map<string, FeatureCollection>;

export type DeckGlGrammarSpec = UrbanSpec;

export { ColorMapInterpolator, NormalizationMode } from '@urban-toolkit/the-urban-grammar';
