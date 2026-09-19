import { test, expect } from '@playwright/test';

test.describe('MuzsikApp E2E Tests', () => {
  /** The app must be running on the configured baseURL before these tests execute. */

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  // ── App load & basic structure ───────────────────────

  test('should show MuzsikApp header', async ({ page }) => {
    const title = page.locator('.app-header h1').first();
    await expect(title).toBeVisible({ timeout: 20_000 });
    await expect(title).toHaveText(/MuzsikApp/i);
  });

  test('should render the main app-content container', async ({ page }) => {
    const content = page.locator('#app-content');
    await expect(content).toBeVisible({ timeout: 20_000 });
  });

  test('should display room selector buttons', async ({ page }) => {
    // At least one active room button should be present (room-1 is the default)
    const rooms = page.locator('.room-btn');
    await expect(rooms).toHaveCount({ min: 1, timeout: 20_000 });

    const firstRoom = rooms.first();
    // The active room gets class "active" and shows its number
    await expect(firstRoom).toBeVisible();
    const ariaLabelOrTitle = (await firstRoom.getAttribute('title')) || '';
    console.log(`First room: ${ariaLabelOrTitle}`);

    // Check that the button text contains at least a digit (room number) or "Room"
    const btnText = await firstRoom.textContent();
    expect(btnText).toMatch(/room|Room|\d/i, 'Expected to see Room label');
  });

  test('should show stats section', async ({ page }) => {
    // Stats area is in the header; it may be empty initially if backend has no tracks/clients yet.
    const statsSection = page.locator('.stats').first();
    await expect(statsSection).toBeVisible({ timeout: 20_000 });

    // Each stat span shows a label like "X tracks" or "Y clients". They may be zero.
    const statSpans = statsSection.locator('.stat');
    const count = await statSpans.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('should have the main layout grid', async ({ page }) => {
    // The app uses CSS Grid for its two-row, multi-column layout. Verify top and bottom rows exist.
    const topRow = page.locator('.top-row').first();
    await expect(topRow).toBeVisible({ timeout: 20_000 });

    const playerColumn = page.locator('.player-column');
    await expect(playerColumn).toBeVisible();

    // Bottom row may be hidden if manage-library is shown, but on a fresh load it should exist.
    const bottomRow = page.locator('.bottom-row').first();
    await expect(bottomRow).toHaveCount(1);
  });

});
