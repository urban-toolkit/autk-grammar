// Prints which Chrome launch flags give a WebGPU adapter on this machine.
// Run with: node tests/webgpu-probe.mjs  (CI runs it before the browser tests)
import { chromium } from '@playwright/test';
import http from 'http';
import fs from 'fs';

const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
    .find((path) => path && fs.existsSync(path));

const variants = {
    'vulkan (tests)': ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-angle=vulkan'],
    'vulkan + use-vulkan': ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--use-angle=vulkan', '--use-vulkan'],
    'webgpu only': ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
    'swiftshader': ['--headless=new', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader'],
};

const server = http.createServer((_, res) => res.end('<!doctype html><title>probe</title>')).listen(0);
const url = `http://localhost:${server.address().port}/`;
console.log(`chrome: ${chrome ?? 'none found, using Playwright Chromium'}`);

for (const [name, args] of Object.entries(variants)) {
    let browser;
    try {
        browser = await chromium.launch({ executablePath: chrome, headless: false, args });
        const page = await browser.newPage();
        await page.goto(url);
        const result = await page.evaluate(async () => {
            if (!navigator.gpu) return 'navigator.gpu missing';
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return 'no adapter';
            const info = adapter.info ?? {};
            return `adapter: ${info.vendor} / ${info.architecture} / ${info.description}${adapter.isFallbackAdapter ? ' (fallback)' : ''}`;
        });
        console.log(`[${name}] ${browser.version()}: ${result}`);
        if (name === 'vulkan (tests)') {
            await page.goto('chrome://version');
            console.log(`  command line: ${await page.locator('#command_line').textContent()}`);
            await page.goto('chrome://gpu');
            await page.waitForTimeout(2000);
            const text = await page.locator('body').innerText();
            const lines = text.split('\n').filter((line) => /WebGPU|Vulkan|GL_RENDERER|Problems|disabled|Dawn/i.test(line));
            console.log(lines.slice(0, 25).map((line) => `  gpu: ${line}`).join('\n'));
        }
    } catch (error) {
        console.log(`[${name}] launch failed: ${error.message.split('\n')[0]}`);
    } finally {
        await browser?.close();
    }
}
server.close();
