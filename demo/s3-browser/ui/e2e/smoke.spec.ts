import { test, expect } from '@playwright/test';

test('health endpoint returns healthy status', async ({ request }) => {
  const res = await request.get('/_/health');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { status?: string };
  expect(body.status).toBe('healthy');
});

test('embedded UI shell loads', async ({ page }) => {
  await page.goto('/_/');
  await expect(page).toHaveTitle(/DeltaGlider/i);
});
