import { defineConfig } from '@playwright/test';
import fs from 'fs';

const PORT = 5179;

// WebGPU needs a real Chrome: Playwright's bundled headless shell has no WebGPU.
function systemChrome(): string | undefined {
    const candidates = [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ];
    return candidates.find((path) => path && fs.existsSync(path));
}

// On Linux, use the GPU through Vulkan (same flags as curio's hardware WebGPU runner).
// Headless has no window to present to: without --disable-vulkan-surface, Chrome in a container
// (the arcade GPU runners) gives up on Vulkan and WebGPU falls back to SwiftShader, which runs
// compute but leaves every map canvas empty.
const linuxGpuArgs = [
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--disable-vulkan-surface',
];

export default defineConfig({
    testDir: '.',
    testMatch: '*.spec.ts',
    outputDir: 'test-results',
    timeout: 180_000,
    expect: { timeout: 30_000 },
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
        launchOptions: {
            executablePath: systemChrome(),
            args: process.platform === 'linux' ? ['--headless=new', ...linuxGpuArgs] : ['--enable-unsafe-webgpu'],
        },
        // --headless=new is passed explicitly on Linux; keep Playwright from adding the old flag.
        headless: process.platform !== 'linux',
    },
    webServer: {
        command: `npx vite --config tests/app/vite.config.ts --port ${PORT} --strictPort`,
        cwd: '..',
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
