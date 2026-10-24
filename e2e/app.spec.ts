import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const USER = 'e2e-admin';
const PASSWORD = `e2e-${Date.now()}-passphrase`;
const tokenFile = () => path.join(process.env.E2E_DATA_DIR!, 'setup-token.txt');
const credsFile = () => path.join(process.env.E2E_DATA_DIR!, 'e2e-creds.json');

async function login(page: Page) {
  const { password } = JSON.parse(fs.readFileSync(credsFile(), 'utf8')) as { password: string };
  await page.goto('/');
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Engineering Overview' })).toBeVisible();
}

test.describe.serial('first run and navigation', () => {
  test('first-run setup creates the administrator', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create the administrator account' })).toBeVisible();
    await page.getByLabel('Setup token').fill(fs.readFileSync(tokenFile(), 'utf8').trim());
    await page.getByLabel('Username').fill(USER);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirm password').fill(PASSWORD);
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page.getByRole('heading', { name: 'Engineering Overview' })).toBeVisible();
    fs.writeFileSync(credsFile(), JSON.stringify({ password: PASSWORD }));
    expect(fs.existsSync(tokenFile())).toBe(false);
  });

  test('empty state shows unknown, not fabricated, metrics', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'later projects run after data exists');
    await login(page);
    await expect(page.getByText(/Nothing is connected yet/)).toBeVisible();
    await expect(page.getByRole('img', { name: /Health score not calculated/ })).toBeVisible();
  });

  test('every section renders without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await login(page);
    for (const [link, heading] of [
      ['Repositories', 'Repositories'], ['Pipelines', 'CI/CD Pipelines'], ['Security', 'Security Intelligence'], ['Monitoring', 'Live Monitoring'],
      ['Incidents', 'Incidents'], ['Load tests', 'Performance & Capacity'], ['Analytics', 'Analytics'], ['Settings', 'Settings'],
    ] as const) {
      if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('navigation').getByRole('link', { name: link, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${link} has horizontal overflow`).toBeLessThanOrEqual(1);
    }
    expect(errors).toEqual([]);
  });

  test('a local monitor records a real check', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop');
    await login(page);
    await page.goto('/monitoring');
    await page.getByRole('button', { name: 'Add monitor' }).click();
    await page.getByLabel('URL').fill('http://127.0.0.1:4620/api/health');
    await page.getByLabel('Name').fill('E2E self check');
    await page.getByRole('button', { name: 'Start monitoring' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'E2E self check' })).toBeVisible();
    await expect(page.getByText(/HTTP 200/).first()).toBeVisible({ timeout: 15_000 });
  });

  test('signing out ends the session', async ({ page }) => {
    await login(page);
    if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: new RegExp(USER) }).click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to SentinelOps' })).toBeVisible();
    expect((await page.request.get('/api/overview')).status()).toBe(401);
  });
});
