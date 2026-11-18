import { PlotSpec } from "../types";

/**
 * Interface for plots.
 * @property {Promise<unknown>} resolvePlot - Resolves a plot specification.
    * @param {unknown} context Grand grammar context for sharing data between adapters.
    * @param {PlotSpec} spec The plot to draw.
    * @param {number} index Position of the plot among the plots of the specification, so an adapter given one target per plot can pick its own.
 */
export interface PlotAdapter {
    resolvePlot(context: unknown, spec: PlotSpec, index?: number): Promise<unknown>;
}