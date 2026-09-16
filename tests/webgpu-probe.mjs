// Prints which Chrome launch setups give a WebGPU adapter on this machine.
// Run with: node tests/webgpu-probe.mjs  (CI runs it before the browser tests)
import { chromium } from '@playwright/test';
import { execFile } from 'child_process';
import http from 'http';
import fs from 'fs';

const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
    .find((path) => path && fs.existsSync(path));

const vulkan = ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-angle=vulkan'];

const variants = {
    'vulkan (tests)': { args: vulkan },
    'vulkan, no unsafe-swiftshader default': { args: vulkan, ignoreDefaultArgs: ['--enable-unsafe-swiftshader'] },
    'vulkan, no swiftshader/sandbox defaults': { args: vulkan, ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--no-sandbox'] },
    'vulkan, no CDP screenshot feature': { args: vulkan, ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--enable-features=CDPScreenshotNewSurface'] },
    'webgpu only': { args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] },
};

const probePage = `<!doctype html><title>probe</title><pre id="out">pending</pre><script>
(async () => {
  const out = document.getElementById('out');
  if (!navigator.gpu) { out.textContent = 'navigator.gpu missing'; return; }
  const start = performance.now();
  for (let attempt = 1; attempt <= 30; attempt++) {
    const options = attempt % 2 ? {} : { powerPreference: 'high-performance' };
    const adapter = await navigator.gpu.requestAdapter(options);
    if (adapter) {
      const info = adapter.info || {};
      out.textContent = 'adapter after ' + Math.round(performance.now() - start) + ' ms (attempt ' + attempt + ', ' + JSON.stringify(options) + '): ' +
        info.vendor + ' / ' + info.architecture + ' / ' + info.description + (adapter.isFallbackAdapter ? ' (fallback)' : '');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  out.textContent = 'no adapter after 15 s of retries';
})();
</script>`;
const server = http.createServer((_, res) => res.end(probePage)).listen(0);
const url = `http://localhost:${server.address().port}/`;
console.log(`chrome: ${chrome ?? 'none found, using Playwright Chromium'}`);

async function gpuPageSummary(page) {
    await page.goto('chrome://gpu');
    await page.waitForTimeout(3000);
    const lines = await page.evaluate(() => {
        const root = document.querySelector('info-view')?.shadowRoot ?? document;
        return Array.from(root.querySelectorAll('h3, tr, li')).map((el) => el.textContent.replace(/\s+/g, ' ').trim());
    });
    return lines.filter((line) => /WebGPU|Vulkan|Dawn|GL_RENDERER|ANGLE|Problems|disabled|blocklist|error/i.test(line)).slice(0, 30);
}

for (const [name, options] of Object.entries(variants)) {
    let browser;
    try {
        browser = await chromium.launch({ executablePath: chrome, headless: false, ...options });
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction(() => document.getElementById('out').textContent !== 'pending', null, { timeout: 30000 });
        console.log(`[${name}] ${await page.locator('#out').textContent()}`);
        if (name === 'vulkan (tests)') {
            for (const line of await gpuPageSummary(page)) console.log(`  gpu: ${line}`);
        }
    } catch (error) {
        console.log(`[${name}] failed: ${error.message.split('\n')[0]}`);
    } finally {
        await browser?.close();
    }
}

// Chrome on its own, without Playwright's default switches.
if (chrome) {
    const result = await new Promise((resolve) => {
        execFile(chrome, [...vulkan, '--virtual-time-budget=30000', '--dump-dom', url], { timeout: 60000 }, (error, stdout, stderr) => {
            const match = stdout.match(/<pre id="out">([^<]*)<\/pre>/);
            resolve(match ? match[1] : `no output (${error?.message ?? stderr.slice(0, 200)})`);
        });
    });
    console.log(`[chrome alone, vulkan] ${result}`);
}
server.close();
