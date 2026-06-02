import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkGrammar } from '@urban-toolkit/autk-grammar';

export const spec: UrbanSpec = {
    data: [
        {
            type: 'geojson',
            geojsonFileUrl: '/data/mnt_neighs_proj.geojson',
            outputTableName: 'neighborhoods',
            coordinateFormat: 'EPSG:3395',
        },
    ],
    map: {
        layerRefs: [{ dataRef: 'neighborhoods', isPick: true }],
    },
    plot: {
        dataRef: 'neighborhoods',
        mark: 'scatter',
        axis: ['shape_area', 'shape_leng'],
        title: 'Neighborhood Areas',
        width: 420,
        events: ['click', 'brush'],
        mapRef: 'neighborhoods',
    },
};

export async function afterRun(grammar: unknown): Promise<void> {
    const g = grammar as AutkGrammar;

    // --- Interaction console panel ---
    const panel = document.createElement('div');
    panel.id = 'interaction-console';
    panel.style.cssText = [
        'position:fixed',
        'bottom:16px',
        'left:16px',
        'width:400px',
        'background:#1e1e2e',
        'border:1px solid #44475a',
        'border-radius:8px',
        'font-family:monospace',
        'font-size:12px',
        'color:#cdd6f4',
        'z-index:1000',
        'overflow:hidden',
        'box-shadow:0 4px 20px rgba(0,0,0,.5)',
    ].join(';');

    panel.innerHTML = `
        <div style="padding:8px 12px;background:#313244;font-weight:bold;font-size:13px;
                    display:flex;align-items:center;gap:8px;user-select:none">
            <span style="color:#cba6f7">⬡</span> Interaction Console
        </div>

        <div style="padding:10px 12px;border-bottom:1px solid #313244">
            <div style="margin-bottom:6px;color:#6c7086;font-size:10px;
                        text-transform:uppercase;letter-spacing:.06em">Trigger (external → grammar)</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button id="ib-highlight"
                    style="padding:4px 10px;background:#45475a;border:none;border-radius:4px;
                           color:#cdd6f4;cursor:pointer;font-size:11px">
                    highlightOnMap [0,1,2]
                </button>
                <button id="ib-select"
                    style="padding:4px 10px;background:#45475a;border:none;border-radius:4px;
                           color:#cdd6f4;cursor:pointer;font-size:11px">
                    setPlotSelection [0,1,2]
                </button>
                <button id="ib-clear-map"
                    style="padding:4px 10px;background:#45475a;border:none;border-radius:4px;
                           color:#f38ba8;cursor:pointer;font-size:11px">
                    clearHighlightOnMap
                </button>
                <button id="ib-clear-plot"
                    style="padding:4px 10px;background:#45475a;border:none;border-radius:4px;
                           color:#f38ba8;cursor:pointer;font-size:11px">
                    clearHighlightOnPlot
                </button>
            </div>
        </div>

        <div style="padding:10px 12px">
            <div style="margin-bottom:6px;color:#6c7086;font-size:10px;
                        text-transform:uppercase;letter-spacing:.06em">Event log (grammar → external)</div>
            <div id="ib-log"
                style="height:150px;overflow-y:auto;display:flex;flex-direction:column;gap:2px">
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    const log = panel.querySelector('#ib-log') as HTMLElement;

    function appendLog(color: string, label: string, detail: string) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:2px 0;border-bottom:1px solid #313244;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        row.innerHTML = `<span style="color:${color}">${label}</span> <span style="color:#585b70">${detail}</span>`;
        log.prepend(row);
        if (log.children.length > 30) log.lastElementChild?.remove();
    }

    // --- Listen: grammar → external ---

    g.interactions.on('map:picking', ({ layerId, selection }) => {
        const ids = selection.length > 5
            ? `[${selection.slice(0, 5).join(', ')}, …+${selection.length - 5}]`
            : `[${selection.join(', ')}]`;
        appendLog('#89b4fa', 'map:picking', `layerId="${layerId}" selection=${ids}`);
    });

    g.interactions.on('plot:selection', ({ plotId, event, selection }) => {
        const ids = selection.length > 5
            ? `[${selection.slice(0, 5).join(', ')}, …+${selection.length - 5}]`
            : `[${selection.join(', ')}]`;
        appendLog('#a6e3a1', 'plot:selection', `plotId="${plotId}" event="${event}" selection=${ids}`);
    });

    // --- Trigger: external → grammar ---

    panel.querySelector('#ib-highlight')!.addEventListener('click', () => {
        g.highlightOnMap('neighborhoods', [0, 1, 2]);
        appendLog('#cba6f7', '→ highlightOnMap', '"neighborhoods" [0, 1, 2]');
    });

    panel.querySelector('#ib-select')!.addEventListener('click', () => {
        g.setPlotSelection('neighborhoods', [0, 1, 2]);
        appendLog('#cba6f7', '→ setPlotSelection', '"neighborhoods" [0, 1, 2]');
    });

    panel.querySelector('#ib-clear-map')!.addEventListener('click', () => {
        g.clearHighlightOnMap('neighborhoods');
        appendLog('#f38ba8', '→ clearHighlightOnMap', '"neighborhoods"');
    });

    panel.querySelector('#ib-clear-plot')!.addEventListener('click', () => {
        g.clearHighlightOnPlot('neighborhoods');
        appendLog('#f38ba8', '→ clearHighlightOnPlot', '"neighborhoods"');
    });
}
