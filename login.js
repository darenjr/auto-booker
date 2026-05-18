require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');

chromium.use(stealth);

const LOGIN_URL = process.env.LOGIN_URL || 'https://thekallang.perfectgym.com/clientportal2/#/Login';
const USERNAME = process.env.PG_USERNAME;
const PASSWORD = process.env.PG_PASSWORD;
const HEADLESS = process.env.HEADLESS !== 'false';

if (!USERNAME || !PASSWORD) {
  console.error('[FATAL] PG_USERNAME and PG_PASSWORD must be set in .env');
  process.exit(1);
}

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function ensureOnFacilityBookingPage(page) {
  if (page.url().includes('FacilityBooking')) {
    log('Already on FacilityBooking page.');
    return;
  }
  log('Not on FacilityBooking page — clicking Facility nav link...');
  const navStart = Date.now();
  await page.click('a[baf-state="FacilityBookings"]');
  await page.waitForURL(/FacilityBooking/, { timeout: 15000 });
  log(`Navigated to FacilityBooking in ${Date.now() - navStart}ms (url=${page.url()})`);
}

async function selectFacilityType(page, facilityName) {
  const comboRoot = 'baf\\:combobox[name="facilityTypeCombo"]';
  const comboInput = `${comboRoot} .baf-combobox-input`;
  const selectedItem = `${comboRoot} .baf-combobox-selected-item`;

  log(`Waiting for facility type combobox...`);
  await page.waitForSelector(comboInput, { timeout: 15000 });

  const currentText = (await page.locator(selectedItem).first().textContent().catch(() => '') || '').trim();
  log(`Current facility type: "${currentText}"`);

  if (currentText === facilityName) {
    log(`[OK] Already filtered to ${facilityName} — no action needed.`);
    return;
  }

  log(`Opening dropdown to select "${facilityName}"...`);
  const selectStart = Date.now();
  await page.click(comboInput);

  const searchInput = page.locator('input[placeholder="Search..."]:visible').first();
  const searchTerm = facilityName.split(' ')[0];
  try {
    await searchInput.waitFor({ timeout: 4000 });
    await searchInput.fill(searchTerm);
    log(`Typed "${searchTerm}" in search to filter options.`);
  } catch (_) {
    log('No search input visible — will click option directly.');
  }

  const clicked = await page.evaluate((name) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = Array.from(document.querySelectorAll('span, li, div, a, button'));
    for (const el of candidates) {
      if (el.textContent.trim() !== name) continue;
      if (!isVisible(el)) continue;
      const target = el.closest('[ng-click], li, [role="option"], .baf-combobox-list-item') || el;
      target.click();
      return { ok: true, tag: target.tagName, cls: target.className };
    }
    return { ok: false };
  }, facilityName);

  if (!clicked.ok) {
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `dropdown-open-${ts()}.png`),
      fullPage: true,
    });
    throw new Error(`Could not click dropdown option "${facilityName}". See dropdown-open screenshot.`);
  }
  log(`Clicked option "${facilityName}" via ${clicked.tag}.${clicked.cls || ''}`);

  await page.waitForFunction(
    ({ sel, expected }) => {
      const el = document.querySelector(sel);
      return el && el.textContent.trim() === expected;
    },
    { sel: selectedItem, expected: facilityName },
    { timeout: 8000 },
  );

  const newText = (await page.locator(selectedItem).first().textContent()).trim();
  log(`[OK] Filtered to "${newText}" in ${Date.now() - selectStart}ms.`);
}

(async () => {
  log(`Launching Chromium (headless=${HEADLESS})...`);
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    locale: 'en-AU',
    timezoneId: 'Australia/Melbourne',
  });

  const page = await context.newPage();

  try {
    log(`Navigating to ${LOGIN_URL}`);
    const navStart = Date.now();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    log(`Page loaded in ${Date.now() - navStart}ms`);

    const usernameSel = 'input[name="Login"]';
    const passwordSel = 'input[name="Password"]';
    const loginBtnSel = 'baf\\:button#confirm';

    log('Waiting for login form...');
    await page.waitForSelector(usernameSel, { timeout: 15000 });
    await page.waitForSelector(passwordSel, { timeout: 15000 });

    log('Filling credentials...');
    await page.fill(usernameSel, USERNAME);
    await page.fill(passwordSel, PASSWORD);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `before-submit-${ts()}.png`) });

    log('Submitting login...');
    const submitStart = Date.now();
    await Promise.all([
      page
        .waitForURL((url) => !url.toString().includes('/Login'), { timeout: 20000 })
        .catch(() => null),
      page.click(loginBtnSel),
    ]);
    log(`Login request settled in ${Date.now() - submitStart}ms`);

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);

    const currentUrl = page.url();
    log(`Post-login URL: ${currentUrl}`);

    const stillOnLogin = currentUrl.includes('/Login');
    const errorVisible = await page
      .locator('.baf-validation-message, .cp-login-error, .alert-danger')
      .first()
      .isVisible()
      .catch(() => false);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `after-submit-${ts()}.png`), fullPage: true });

    if (stillOnLogin || errorVisible) {
      log('[FAIL] Login did not succeed. Still on login page or error visible.');
      const errText = await page
        .locator('.baf-validation-message, .cp-login-error, .alert-danger')
        .first()
        .textContent()
        .catch(() => null);
      if (errText) log(`Error text: ${errText.trim()}`);
      process.exitCode = 2;
      return;
    }

    log('[OK] Login successful — redirected away from login page.');
    await context.storageState({ path: path.join(__dirname, 'auth-state.json') });
    log('Saved auth state to auth-state.json');

    await ensureOnFacilityBookingPage(page);
    await selectFacilityType(page, 'Volleyball Courts');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `volleyball-filtered-${ts()}.png`),
      fullPage: true,
    });
  } catch (err) {
    log(`[ERROR] ${err.message}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `error-${ts()}.png`), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    log('Browser closed.');
  }
})();
