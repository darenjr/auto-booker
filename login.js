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
    } else {
      log('[OK] Login successful — redirected away from login page.');
      await context.storageState({ path: path.join(__dirname, 'auth-state.json') });
      log('Saved auth state to auth-state.json');
    }
  } catch (err) {
    log(`[ERROR] ${err.message}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `error-${ts()}.png`), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    log('Browser closed.');
  }
})();
