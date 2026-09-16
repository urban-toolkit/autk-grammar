# Browser tests

These tests run gallery example specs through the grammar in Chrome with WebGPU, and check the results: loaded tables, spatial joins, GPU compute values, linked plots, and that each map canvas was actually drawn. They run the adapter and grammar **source** against whichever Autark packages are installed.

CI (`.github/workflows/e2e.yml`) runs them on every pull request and every push to `main`, twice:

- **locked**: the Autark versions in `package-lock.json`.
- **latest**: the newest `@urban-toolkit/autk-*` releases on npm. A failure here while `locked` passes means a new Autark release broke the grammar.

## Running locally

```sh
npm install
npm run test:e2e
```

The tests need a Chrome with WebGPU. They use the system Chrome when it is installed; otherwise point `CHROME_PATH` at a Chrome binary.

## Adding a test

`tests/app/main.ts` exposes `window.runExample(name)`, which runs `gallery/src/examples/<name>.ts` and returns the tables it produced, and `window.valueAt(table, index, path)` to read a feature property. Add a case to `tests/grammar.spec.ts` that runs an example and checks what it should produce.
