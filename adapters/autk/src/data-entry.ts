/**
 * The `@urban-toolkit/autk-grammar/data` entry, for hosts that load a spec's tables without a map or a plot, such as
 * a server in Node. It holds the data adapter alone, so its only import at run time is autk-db: nothing of autk-map,
 * autk-plot, autk-compute or autk-core loads.
 */
export { createDataAdapter } from './adapters/data';
export { enterWorkspace, tableKey } from './workspace';
export type { Targets, GeoJsonCache } from './types';
export type {
    DataAdapter,
    DataSourceSpec,
    OsmDataSourceSpec,
    CsvDataSourceSpec,
    JsonDataSourceSpec,
    CustomDataSourceSpec,
    GeoTiffDataSourceSpec,
    HeatmapSourceSpec,
    JoinSourceSpec,
    WorkspaceName,
} from '@urban-toolkit/the-urban-grammar';
