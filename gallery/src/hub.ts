import { EXAMPLES, type AdapterName, type Layout } from './examples';

const exampleSelect = document.getElementById('example-select') as HTMLSelectElement;
const adapterSelect = document.getElementById('adapter-select') as HTMLSelectElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
const stage = document.getElementById('stage') as HTMLElement;
const statusBar = document.getElementById('status-bar') as HTMLElement;
const toolbar = document.getElementById('toolbar') as HTMLElement;

// ── Spec overlay ──────────────────────────────────────────────────────────────

const specOverlay = document.createElement('div');
specOverlay.className = 'floating-panel spec-overlay hidden';
document.body.appendChild(specOverlay);

function positionOverlay() {
    const top = toolbar.offsetHeight + 16;
    specOverlay.style.top = `${top}px`;
    specOverlay.style.left = '16px';
    specOverlay.style.maxHeight = `calc(100vh - ${top + 16}px)`;
}

async function updateSpecOverlay(exampleId: string) {
    if (!exampleId) {
        specOverlay.classList.add('hidden');
        return;
    }
    positionOverlay();
    specOverlay.classList.remove('hidden');
    specOverlay.textContent = '// loading…';
    try {
        const { spec } = await EXAMPLES[exampleId].load();
        specOverlay.textContent = JSON.stringify(spec, null, 2);
    } catch {
        specOverlay.textContent = '// failed to load spec';
    }
}

// ── Drag helper ───────────────────────────────────────────────────────────────

function makeDraggable(panel: HTMLElement, handle: HTMLElement) {
    let newX = 0, newY = 0, startX = 0, startY = 0;

    handle.addEventListener('mousedown', mouseDown);

    function mouseDown(e: MouseEvent) {
        startX = e.clientX;
        startY = e.clientY;
        document.addEventListener('mousemove', mouseMove);
        document.addEventListener('mouseup', mouseUp);
    }

    function mouseMove(e: MouseEvent) {
        newX = startX - e.clientX;
        newY = startY - e.clientY;
        startX = e.clientX;
        startY = e.clientY;
        panel.style.top = panel.offsetTop - newY + 'px';
        panel.style.left = panel.offsetLeft - newX + 'px';
        panel.style.right = 'auto';
        e.preventDefault();
        e.stopPropagation();
    }

    function mouseUp() {
        document.removeEventListener('mousemove', mouseMove);
    }
}

// ── Stage setup ───────────────────────────────────────────────────────────────

let floatingPlotPanel: HTMLElement | null = null;

function setStatus(msg: string, state: 'loading' | 'error' | 'done' | '') {
    statusBar.textContent = msg;
    statusBar.className = state;
}

function populateExamples() {
    for (const [id, meta] of Object.entries(EXAMPLES)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = meta.title;
        exampleSelect.appendChild(opt);
    }
}

function updateAdapterOptions(exampleId: string) {
    const meta = EXAMPLES[exampleId];
    if (!meta) {
        adapterSelect.querySelectorAll('option').forEach(o => (o.disabled = false));
        return;
    }
    adapterSelect.querySelectorAll('option').forEach(o => {
        o.disabled = !meta.supportedAdapters.includes(o.value as AdapterName);
    });
    if ((adapterSelect.options[adapterSelect.selectedIndex] as HTMLOptionElement)?.disabled) {
        const first = Array.from(adapterSelect.options).find(o => !o.disabled);
        if (first) adapterSelect.value = first.value;
    }
}

function createMapEl(adapter: AdapterName, id: string): HTMLElement {
    if (adapter === 'autk') {
        const canvas = document.createElement('canvas');
        canvas.id = id;
        canvas.className = 'map-el';
        return canvas;
    }
    const div = document.createElement('div');
    div.id = id;
    div.className = 'map-el';
    return div;
}

function setupStage(layout: Layout, adapter: AdapterName): Record<string, string | string[]> {
    stage.innerHTML = '';
    floatingPlotPanel?.remove();
    floatingPlotPanel = null;

    if (layout === 'data-only') {
        const out = document.createElement('div');
        out.id = 'debug-output';
        out.className = 'debug-output';
        stage.appendChild(out);
        return { db: 'debug-output' };
    }

    if (layout === 'multi-map') {
        const wrap = document.createElement('div');
        wrap.className = 'maps-wrap multi';

        const id0 = adapter === 'autk' ? 'map-canvas-0' : 'map-container-0';
        const id1 = adapter === 'autk' ? 'map-canvas-1' : 'map-container-1';

        const slot0 = document.createElement('div');
        slot0.className = 'map-slot';
        slot0.appendChild(createMapEl(adapter, id0));
        wrap.appendChild(slot0);

        const slot1 = document.createElement('div');
        slot1.className = 'map-slot';
        slot1.appendChild(createMapEl(adapter, id1));
        wrap.appendChild(slot1);

        stage.appendChild(wrap);
        return { map: [id0, id1] };
    }

    if (layout === 'map+plot') {
        const wrap = document.createElement('div');
        wrap.className = 'maps-wrap single';
        const mapId = adapter === 'autk' ? 'map-canvas' : 'map-container';
        wrap.appendChild(createMapEl(adapter, mapId));
        stage.appendChild(wrap);

        const plotPanel = document.createElement('div');
        plotPanel.className = 'floating-panel plot-panel';
        const toolbarH = toolbar.offsetHeight;
        plotPanel.style.right = '16px';
        plotPanel.style.top = `${toolbarH + 16}px`;

        const plotBar = document.createElement('div');
        plotBar.className = 'plot-bar';
        const grip = document.createElement('div');
        grip.className = 'plot-bar-grip';
        grip.appendChild(document.createElement('span'));
        grip.appendChild(document.createElement('span'));
        grip.appendChild(document.createElement('span'));
        plotBar.appendChild(grip);
        plotBar.appendChild(document.createTextNode('Plot'));

        const plotBody = document.createElement('div');
        plotBody.id = 'plot-body';
        plotBody.className = 'plot-body';

        plotPanel.appendChild(plotBar);
        plotPanel.appendChild(plotBody);
        document.body.appendChild(plotPanel);
        makeDraggable(plotPanel, plotBar);
        floatingPlotPanel = plotPanel;

        return { map: mapId, plot: 'plot-body' };
    }

    // layout === 'map'
    const wrap = document.createElement('div');
    wrap.className = 'maps-wrap single';
    const mapId = adapter === 'autk' ? 'map-canvas' : 'map-container';
    wrap.appendChild(createMapEl(adapter, mapId));
    stage.appendChild(wrap);
    return { map: mapId };
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function runExample(exampleId: string, adapter: AdapterName) {
    const meta = EXAMPLES[exampleId];
    if (!meta) return;

    runBtn.disabled = true;
    setStatus('Loading…', 'loading');

    try {
        const { spec } = await meta.load();
        const targets = setupStage(meta.layout, adapter);

        if (adapter === 'autk') {
            const { AutkGrammar } = await import('@urban-toolkit/autk-grammar');
            const grammar = new AutkGrammar(targets);
            await grammar.run(spec);
        } else {
            const { DeckGlGrammar } = await import('@urban-toolkit/deckgl-grammar');
            const grammar = new DeckGlGrammar(targets);
            await grammar.run(spec);
        }

        setStatus('Done', 'done');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(`Error: ${msg}`, 'error');
        console.error(err);
    } finally {
        runBtn.disabled = false;
    }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

exampleSelect.addEventListener('change', () => {
    const id = exampleSelect.value;
    runBtn.disabled = !id;
    updateAdapterOptions(id);
    updateSpecOverlay(id);
});

runBtn.addEventListener('click', () => {
    const id = exampleSelect.value;
    const adapter = adapterSelect.value as AdapterName;
    if (id) runExample(id, adapter);
});

populateExamples();
