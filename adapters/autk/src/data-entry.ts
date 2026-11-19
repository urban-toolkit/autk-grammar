/**
 * The `@urban-toolkit/autk-grammar/data` entry, for hosts that load a spec's tables without a map or a plot, such as
 * a server in Node. It holds the data adapter alone, so its only import at run time is autk-db, never autk-map,
 * autk-plot, autk-compute or autk-core (tests/unit/data-entry.mts checks the built files).
 */
export { createDataAdapter } from './adapters/data';
export { enterWorkspace, tableKey } from './workspace';
export type { Targets, GeoJsonCache } from './types';
export type {
    DataAdapter,
    DataSourceSpec,
    OsmDataSourceSpec,
    OsmTagSet,
    OsmTagFilter,
    CsvDataSourceSpec,
    JsonDataSourceSpec,
    CustomDataSourceSpec,
    GeoTiffDataSourceSpec,
    HeatmapSourceSpec,
    JoinSourceSpec,
    SqlSourceSpec,
    UpdateSourceSpec,
    WorkspaceName,
    WorkspaceSpec,
} from '@urban-toolkit/the-urban-grammar';
