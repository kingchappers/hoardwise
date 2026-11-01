// Run with `yarn screenshots`. Starts the dev server against dummy Auth0 values, signs in with a seeded
// session, answers /api from fixtures, and saves WebP screenshots to public/about/.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { SCHEMES, SHOTS, SIZES, shotFileName } from '../../app/lib/aboutShots.ts';
import { DUMMY_ENV, authStorage } from './auth.mjs';
import { createStore, referenceNow } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'public', 'about');

// The pages are loaded at this invented host, which Chromium maps to the dev server, so the address the app
// shows (Settings > AI assistants) is the same on every run instead of a random local port. A .localhost host
// is a secure context (the Auth0 SDK needs one) and Vite allows it without extra configuration.
const SHOT_HOST = 'hoardwise.localhost';
const SHOT_ORIGIN = `http://${SHOT_HOST}`;

function refuseRealTenant() {
  for (const [name, dummy] of Object.entries(DUMMY_ENV)) {
    const existing = process.env[name];
    if (existing && existing !== dummy) {
      throw new Error(`${name} is set in this shell. Refusing to run against it; unset it and try again.`);
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startDevServer(port) {
  const child = spawn('yarn', ['dev', '--port', String(port), '--strictPort'], {
    cwd: ROOT, env: { ...process.env, ...DUMMY_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const url = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).ok) return { child, url };
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error(`The dev server did not start. Output:\n${log}`);
}

async function openAddSheet(page) {
  await page.getByRole('button', { name: 'Add transaction' }).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByLabel('Amount').fill('4.20');
  // The chip's label starts with the category emoji, so match the name rather than the whole text.
  await dialog.getByText(/Groceries/).first().click();
  await page.waitForTimeout(800);
}

async function capture(browser, url, store, now, failures, shot, sizeName, scheme) {
  const { width, height } = SIZES[sizeName];
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
  await context.addInitScript(({ entries, colorScheme }) => {
    for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
    // Mantine reads its colour scheme from here, so the dark shots do not depend on the OS setting.
    window.localStorage.setItem('mantine-color-scheme-value', colorScheme);
  }, { entries: authStorage(now), colorScheme: scheme });
  // The app's idea of today must match the date the fixtures were built for.
  await context.clock.setFixedTime(now);
  await context.route('**/*', async route => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    if (pathname === '/config.json') {
      // The dev server has no build step to write this file, and a 404 would log a console error.
      const config = { auth: 'auth0', domain: DUMMY_ENV.VITE_AUTH0_DOMAIN, clientId: DUMMY_ENV.VITE_AUTH0_CLIENT_ID, audience: DUMMY_ENV.VITE_AUTH0_AUDIENCE };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
    }
    if (!pathname.startsWith('/api/')) return route.fallback();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    const { status, json } = store.handle(request.method(), pathname, searchParams, body);
    if (status === 404) failures.push(`${shot.id}/${sizeName}/${scheme}: ${json.error}`);
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
  });

  const page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error') failures.push(`${shot.id}/${sizeName}/${scheme}: console error: ${message.text()}`);
  });
  page.on('pageerror', error => failures.push(`${shot.id}/${sizeName}/${scheme}: page error: ${error.message}`));

  await page.goto(`${url}${shot.route}`, { waitUntil: 'networkidle' });
  if (shot.id === 'add') await openAddSheet(page);
  if (shot.id === 'insights') await page.getByRole('heading', { name: 'Spending by group' }).evaluate(el => { el.scrollIntoView(); window.scrollBy(0, -90); });
  await page.waitForTimeout(400);

  const png = await page.screenshot({ type: 'png' });
  await sharp(png).webp({ quality: 82 }).toFile(path.join(OUT_DIR, shotFileName(shot.id, sizeName, scheme)));
  await context.close();
}

async function main() {
  refuseRealTenant();
  await mkdir(OUT_DIR, { recursive: true });
  const port = await freePort();
  const { child, url } = await startDevServer(port);
  const failures = [];
  let browser;
  try {
    browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${SHOT_HOST} localhost:${port}`] });
    const now = referenceNow();
    const store = createStore(now);
    // The first load makes Vite re-optimise its dependencies, which reloads the page. Do it once up front.
    const warm = await browser.newPage();
    await warm.goto(SHOT_ORIGIN, { waitUntil: 'networkidle' });
    await warm.waitForTimeout(3000);
    await warm.close();

    for (const shot of SHOTS) {
      for (const sizeName of Object.keys(SIZES)) {
        for (const scheme of SCHEMES) {
          await capture(browser, SHOT_ORIGIN, store, now, failures, shot, sizeName, scheme);
          console.log(`saved ${shotFileName(shot.id, sizeName, scheme)}`);
        }
      }
    }
  } finally {
    await browser?.close();
    child.kill();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} problem(s):\n${[...new Set(failures)].join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
