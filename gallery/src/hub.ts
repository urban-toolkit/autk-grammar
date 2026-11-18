import type { UrbanSpec } from '@urban-toolkit/the-urban-grammar';
import type { AutkGrammar } from '@urban-toolkit/autk-grammar';
import type { DeckGlGrammar } from '@urban-toolkit/deckgl-grammar';
import { EXAMPLES, type AdapterName, type ExampleModule, type Layout } from './examples';
import { createPanes } from './views';

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

// ── Stage setup ───────────────────────────────────────────────────────────────

/**
 * The grammar of the last run. An AutkGrammar is destroyed before the next run, so its maps release their GPU textures
 * and buffers and their event handlers; a DeckGlGrammar has no destroy().
 */
let lastGrammar: AutkGrammar | DeckGlGrammar | null = null;

/** What the last example's afterRun added to the page, such as a console panel, removed before the next run. */
let afterRunElements: Element[] = [];

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

/**
 * Builds the stage for an example and returns the grammar's targets: a pane for each of the spec's views, placed as
 * `arrangeViews` says, as every host arranges them (see `createPanes`). Without a `layout`, the panes stack. An
 * example that draws nothing lists the tables it loads instead.
 */
function setupStage(layout: Layout, adapter: AdapterName, spec: UrbanSpec): Record<string, string | string[]> {
    stage.innerHTML = '';
    for (const element of afterRunElements) element.remove();
    afterRunElements = [];

    if (layout === 'data-only') {
        const out = document.createElement('div');
        out.id = 'debug-output';
        out.className = 'debug-output';
        stage.appendChild(out);
        return { db: 'debug-output' };
    }

    const panes = createPanes(spec, adapter === 'autk' ? 'canvas' : 'div');
    stage.appendChild(panes.element);
    return panes.targets;
}

// ── Run ───────────────────────────────────────────────────────────────────────

/** Runs an example's afterRun, and keeps what it adds to the page so that the next run removes it. */
async function runAfterRun(afterRun: NonNullable<ExampleModule['afterRun']>, grammar: unknown) {
    const before = new Set(Array.from(document.body.children));
    try {
        await afterRun(grammar);
    } finally {
        afterRunElements = Array.from(document.body.children).filter((element) => !before.has(element));
    }
}

async function runExample(exampleId: string, adapter: AdapterName) {
    const meta = EXAMPLES[exampleId];
    if (!meta) return;

    runBtn.disabled = true;
    setStatus('Loading…', 'loading');

    try {
        const module = await meta.load();
        const { spec, afterRun } = module;
        if (lastGrammar && 'destroy' in lastGrammar) lastGrammar.destroy();
        lastGrammar = null;
        const targets = setupStage(meta.layout, adapter, spec);

        if (adapter === 'autk') {
            const { AutkGrammar } = await import('@urban-toolkit/autk-grammar');
            const grammar = new AutkGrammar(targets);
            lastGrammar = grammar;
            await grammar.run(spec);
            if (afterRun) await runAfterRun(afterRun, grammar);
        } else {
            const { DeckGlGrammar } = await import('@urban-toolkit/deckgl-grammar');
            const grammar = new DeckGlGrammar(targets);
            lastGrammar = grammar;
            await grammar.run(spec);
            if (afterRun) await runAfterRun(afterRun, grammar);
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
