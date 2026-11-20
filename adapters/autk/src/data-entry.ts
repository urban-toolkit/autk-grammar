/**
 * The `@urban-toolkit/autk-grammar/data` entry, for hosts that load a spec's tables without a map or a plot, such as
 * a server in Node. It holds the data adapter alone, so its only import at run time is autk-db, never autk-map,
 * autk-plot, autk-compute or autk-core (tests/unit/data-entry.mts checks the built files).
 */
export { createDataAdapter } from './adapters/data';
export { enterWorkspace, tableKey } from './workspace';
// The sources a spec runs before its compute passes and after them, which a host that runs the passes elsewhere splits.
export { dataPhases } from '@urban-toolkit/the-urban-grammar';
export type { Targets, GeoJsonCache, ComputeCache, ComputeLayerTypes } from './types';
export type {
    DataAdapter,
    DataPhases,
    DataSourceSpec,
    SourcePhase,
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
    DropSourceSpec,
    WorkspaceName,
    WorkspaceSpec,
} from '@urban-toolkit/the-urban-grammar';
