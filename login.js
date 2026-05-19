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

// What to book — override via .env or shell vars. Match the exact text the
// site renders (e.g. date "23/5" not "23/05").
const FACILITY_TYPE = process.env.FACILITY_TYPE || 'Volleyball Courts';
const BOOKING_DATE = process.env.BOOKING_DATE || '23/5';
const START_TIME = process.env.START_TIME || '07:00 AM';
const MAX_NEXT_WEEK_CLICKS = 2;

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

async function findAndBookTimeslot(page, targetTime, dayIndex) {
  const rowSel = 'tr[ng-repeat="hour in config.CalendarData track by $index"]';
  await page.waitForSelector(rowSel, { timeout: 15000 });

  log('Waiting 10s for calendar timeslots to fully render...');
  await page.waitForTimeout(10000);

  const result = await page.evaluate(
    ({ rowSel, targetTime, dayIndex }) => {
      const rows = Array.from(document.querySelectorAll(rowSel));
      const hours = [];
      for (const row of rows) {
        const hourEl = row.querySelector('.cp-calendar-hour');
        const hourText = hourEl ? hourEl.textContent.trim() : '';
        hours.push(hourText);
        if (hourText !== targetTime) continue;

        const dayCols = row.querySelectorAll('td.cp-calendar-day-col');
        if (dayIndex >= dayCols.length) {
          return { status: 'bad_index', hourFound: hourText, dayColCount: dayCols.length, hours };
        }
        const cell = dayCols[dayIndex];
        const bookingItem = cell.querySelector('cp\\:facility-booking-item, [class*="cp-calendar-item"]');
        if (!bookingItem) {
          return { status: 'unavailable', hourFound: hourText, hours };
        }
        const bookable = bookingItem.querySelector('.calendar-item-state-bookable');
        const bookableVisible =
          bookable && bookable.offsetParent !== null && getComputedStyle(bookable).display !== 'none';
        if (!bookableVisible) {
          return { status: 'not_bookable', hourFound: hourText, hours };
        }
        // Tag the cta button so Playwright can click it reliably.
        const cta = bookingItem.querySelector('.cp-btn-classes-action');
        if (!cta) {
          return { status: 'no_cta', hourFound: hourText, hours };
        }
        cta.setAttribute('data-autobook-target', '1');
        return { status: 'bookable', hourFound: hourText, hours };
      }
      return { status: 'time_not_found', hours };
    },
    { rowSel, targetTime, dayIndex },
  );

  log(`Visible hours in calendar: [${result.hours.join(', ')}]`);

  if (result.status === 'time_not_found') {
    throw new Error(`Start time "${targetTime}" not found in calendar rows.`);
  }
  if (result.status === 'bad_index') {
    throw new Error(
      `Day column index ${dayIndex} out of range — row has ${result.dayColCount} day columns.`,
    );
  }
  if (result.status === 'unavailable') {
    log(`[UNAVAILABLE] Timeslot ${targetTime} at column ${dayIndex} has no booking item.`);
    return { booked: false, reason: 'unavailable' };
  }
  if (result.status === 'not_bookable') {
    log(`[UNAVAILABLE] Timeslot ${targetTime} at column ${dayIndex} is not in a bookable state.`);
    return { booked: false, reason: 'not_bookable' };
  }
  if (result.status === 'no_cta') {
    throw new Error(`Booking item present at ${targetTime} col ${dayIndex} but no Book-now button found.`);
  }

  log(`[OK] Bookable slot found at ${targetTime}, column ${dayIndex} — clicking Book now...`);
  const clickStart = Date.now();
  await page.click('[data-autobook-target="1"]');
  log(`Book-now clicked in ${Date.now() - clickStart}ms — waiting for popup...`);

  const popupSel =
    '.modal-dialog:visible, .cp-wizard:visible, [class*="wizard"]:visible, .modal.in';
  await page
    .waitForSelector(popupSel, { timeout: 8000 })
    .catch(() => log('No explicit popup selector matched — falling back to fixed wait.'));
  await page.waitForTimeout(2000);

  const shotPath = path.join(SCREENSHOT_DIR, `booking-popup-${ts()}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  log(`[OK] Saved popup screenshot to ${shotPath}`);

  await selectTrainingDuration(page);
  await clickWizardNext(page);
  await executeBookingWithTiming(page, BOOKING_DATE, START_TIME);

  return { booked: true, screenshot: shotPath };
}

async function clickWizardNext(page) {
  const nextSel = 'baf\\:button.cp-btn-next, .cp-btn-next.baf-button';
  log('Waiting for wizard Next button...');
  await page.waitForSelector(nextSel, { timeout: 8000 });
  const clickStart = Date.now();
  await page.click(nextSel);
  log(`Clicked wizard Next in ${Date.now() - clickStart}ms.`);
  // Give the next wizard step a moment to render.
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `after-next-${ts()}.png`),
    fullPage: true,
  });
}

function parseBookingDateTime(bookingDate, startTime) {
  const dm = bookingDate.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!dm) throw new Error(`Could not parse BOOKING_DATE "${bookingDate}" (expected D/M)`);
  const day = Number(dm[1]);
  const month = Number(dm[2]);

  const tm = startTime.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!tm) throw new Error(`Could not parse START_TIME "${startTime}" (expected HH:MM AM/PM)`);
  let hour = Number(tm[1]);
  const minute = Number(tm[2]);
  const ampm = tm[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  const now = new Date();
  let year = now.getFullYear();
  let dt = new Date(year, month - 1, day, hour, minute, 0, 0);
  // If parsed date is well in the past, assume next year (handles Dec/Jan rollover).
  if (dt.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    dt = new Date(year + 1, month - 1, day, hour, minute, 0, 0);
  }
  return dt;
}

async function tagAddToCartElement(page) {
  const tagged = await page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    };

    // Prefer baf:button — that's where the baf:open-modal / wizard-async-next handlers live.
    // The wrapper <div class="cart-button"> has no click handler, so tagging that is useless.
    const bafButtons = Array.from(document.querySelectorAll('baf\\:button'));
    for (const el of bafButtons) {
      const txt = (el.textContent || '').trim();
      if (!/^add\s*to\s*cart$/i.test(txt)) continue;
      if (!isVisible(el)) continue;
      el.setAttribute('data-autobook-cart', '1');
      return { ok: true, tag: el.tagName, cls: el.className, text: txt };
    }

    // Fallback: any clickable-looking element with the text.
    const fallback = Array.from(document.querySelectorAll('button, a, [ng-click], span'));
    for (const el of fallback) {
      const txt = (el.textContent || '').trim();
      if (!/add\s*to\s*cart/i.test(txt)) continue;
      if (txt.length > 40) continue;
      if (!isVisible(el)) continue;
      const target = el.closest('baf\\:button, button, [ng-click], .baf-button') || el;
      target.setAttribute('data-autobook-cart', '1');
      return { ok: true, tag: target.tagName, cls: target.className, text: txt };
    }
    return { ok: false };
  });
  if (!tagged.ok) {
    throw new Error('Could not find an "Add to cart" element on the current wizard step.');
  }
  log(`Tagged add-to-cart: <${tagged.tag}.${tagged.cls}> text="${tagged.text}"`);
}

async function tagBookNowElement(page) {
  log('Looking for confirmation modal...');
  const modalSel = '.baf-modal-content, .baf-open-confirm-footer, .modal-dialog';
  try {
    await page.waitForSelector(modalSel, { timeout: 15000 });
    log('[OK] Confirmation modal detected in DOM.');
  } catch (_) {
    log('[WARN] No modal container detected within 15s — will still try to find Book-now.');
  }

  // Let AngularJS modal transclusion render its children.
  await page.waitForTimeout(500);

  const result = await page.evaluate(() => {
    const inModal = (el) =>
      !!el.closest('.baf-modal-content, .modal-dialog, .baf-open-confirm-footer');

    // Strategy 1 — custom element by tag (most reliable when present).
    const directs = Array.from(document.querySelectorAll('baf\\:button-with-captcha-validation'));
    for (const el of directs) {
      if (!document.contains(el)) continue;
      el.setAttribute('data-autobook-booknow', '1');
      return { ok: true, method: 'tag:baf:button-with-captcha-validation', tag: el.tagName, cls: el.className };
    }

    // Strategy 2 — any element with text="Book now" attribute (the AngularJS interpolation source).
    const byAttr = Array.from(document.querySelectorAll('[text="Book now"]'));
    for (const el of byAttr) {
      if (!document.contains(el)) continue;
      el.setAttribute('data-autobook-booknow', '1');
      return { ok: true, method: '[text="Book now"]', tag: el.tagName, cls: el.className };
    }

    // Strategy 3 — find a span containing "Book now" inside the modal, walk up to the click target.
    const spans = Array.from(document.querySelectorAll('span'));
    for (const sp of spans) {
      const txt = (sp.textContent || '').trim();
      if (txt !== 'Book now') continue;
      if (!inModal(sp)) continue;
      const clickable =
        sp.closest('baf\\:button-with-captcha-validation, baf\\:button, button, [ng-click]') ||
        sp.parentElement;
      if (!clickable) continue;
      clickable.setAttribute('data-autobook-booknow', '1');
      return { ok: true, method: 'span-text-in-modal', tag: clickable.tagName, cls: clickable.className };
    }

    // Diagnostic sample so we can see what's actually in the modal.
    const modal = document.querySelector('.baf-modal-content, .modal-dialog');
    const sample = modal ? (modal.outerHTML || '').substring(0, 600) : '(no modal element found)';
    return { ok: false, sample };
  });

  if (!result.ok) {
    log(`[FAIL] Modal HTML sample: ${result.sample}`);
    throw new Error('Could not find the modal "Book now" button by any strategy.');
  }
  log(`[OK] Tagged Book-now via ${result.method}: <${result.tag}.${result.cls}>`);
}

async function executeBookingWithTiming(page, bookingDate, startTime) {
  const bookingDt = parseBookingDateTime(bookingDate, startTime);
  const releaseTime = new Date(bookingDt.getTime() - 7 * 24 * 60 * 60 * 1000);
  const now = new Date();

  log(`Booking slot:   ${bookingDt.toString()}`);
  log(`Release (T-7d): ${releaseTime.toString()}`);
  log(`Now:            ${now.toString()}`);

  const delayMs = releaseTime.getTime() - now.getTime();

  // Step 1 — coarse sleep BEFORE clicking add-to-cart so the confirmation modal
  // doesn't sit open for hours. Leave a small buffer for the modal to render.
  const PRE_MODAL_BUFFER_MS = 30 * 1000; // open the cart modal 30s before release
  if (delayMs > PRE_MODAL_BUFFER_MS) {
    const coarseSleepMs = delayMs - PRE_MODAL_BUFFER_MS;
    log(
      `Slot is ${(delayMs / 1000 / 60).toFixed(1)} min beyond release. Coarse sleep ${(coarseSleepMs / 1000).toFixed(
        0,
      )}s until T-30s (${new Date(Date.now() + coarseSleepMs).toString()})...`,
    );
    await page.waitForTimeout(coarseSleepMs);
    log('Coarse sleep done.');
  } else if (delayMs > 0) {
    log(`Slot is within ${(delayMs / 1000).toFixed(1)}s of release — clicking add-to-cart now.`);
  } else {
    log('Booking is within 1-week window (release already passed) — going immediately.');
  }

  // Step 2 — click add-to-cart to surface the confirmation modal with the real Book-Now button.
  await tagAddToCartElement(page);
  const cartStart = Date.now();
  await page.click('[data-autobook-cart="1"]');
  log(`Add-to-cart clicked in ${Date.now() - cartStart}ms — waiting for confirmation modal.`);

  // Step 3 — wait for the modal and tag the real Book-Now button.
  await tagBookNowElement(page);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `cart-modal-${ts()}.png`),
    fullPage: true,
  });

  // Step 4 — fire the Book-Now click at exactly T-5ms (or immediately if release passed).
  const fireAt = releaseTime.getTime() - 5;
  const remainingMs = fireAt - Date.now();
  if (remainingMs <= 0) {
    log(`Release time already reached — clicking Book Now immediately.`);
  } else {
    log(`Precision wait — ${remainingMs}ms until fire (target ${new Date(fireAt).toISOString()}).`);
    // Coarse loop down to T-100ms.
    while (Date.now() < fireAt - 100) {
      await page.waitForTimeout(5);
    }
    // Tight spin for the final ~100ms.
    while (Date.now() < fireAt) {
      // busy-wait
    }
  }

  const fireStart = Date.now();
  await page.evaluate(() => {
    const el = document.querySelector('[data-autobook-booknow="1"]');
    if (el) el.click();
  });
  const offset = fireStart - fireAt;
  log(
    `[FIRE] Book-Now dispatched at ${new Date(fireStart).toISOString()} (target ${new Date(
      fireAt,
    ).toISOString()}, offset ${offset >= 0 ? '+' : ''}${offset}ms).`,
  );

  // Quick capture of any immediate response (spinner, captcha challenge, error).
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `after-booknow-1s-${ts()}.png`),
    fullPage: true,
  });

  // Settle wait so any redirect/payment page can render before we close.
  log('Holding browser open for 10s to capture post-booking state...');
  await page.waitForTimeout(10000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `after-booknow-10s-${ts()}.png`),
    fullPage: true,
  });
  log(`Post-booking URL: ${page.url()}`);
}

async function selectTrainingDuration(page) {
  const comboSel = '[aria-label="Training time"].baf-combobox-input';
  log('Looking for training-time dropdown...');
  try {
    await page.waitForSelector(comboSel, { timeout: 8000 });
  } catch (_) {
    log('[WARN] Training-time dropdown not found within 8s — skipping duration selection.');
    return { picked: null, reason: 'no_dropdown' };
  }

  const currentText = (await page
    .locator(`${comboSel} .baf-combobox-selected-item`)
    .first()
    .textContent()
    .catch(() => '') || '').trim();
  log(`Current training time: "${currentText}"`);

  log('Opening training-time dropdown...');
  await page.click(comboSel);
  await page.waitForTimeout(600);

  // Snapshot all visible option-like elements so we know what the dropdown offered.
  const options = await page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const sel = [
      '.baf-combobox-list-item',
      '[role="option"]',
      '.baf-combobox-list li',
      '.baf-combobox-dropdown li',
      'ul.dropdown-menu li',
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes
      .filter(isVisible)
      .map((el) => el.textContent.trim())
      .filter((t) => /\d+\s*min/i.test(t));
  });
  log(`Training-time options visible: [${options.join(' | ')}]`);

  const popupShot = path.join(SCREENSHOT_DIR, `duration-dropdown-open-${ts()}.png`);
  await page.screenshot({ path: popupShot, fullPage: true });

  const preferences = ['120 minutes', '60 minutes'];
  for (const target of preferences) {
    const clicked = await page.evaluate((wanted) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const candidates = Array.from(
        document.querySelectorAll('.baf-combobox-list-item, [role="option"], li, span'),
      );
      for (const el of candidates) {
        const text = el.textContent.trim();
        if (text !== wanted) continue;
        if (!isVisible(el)) continue;
        const clickTarget =
          el.closest('.baf-combobox-list-item, [role="option"], li, [ng-click]') || el;
        clickTarget.click();
        return { ok: true, tag: clickTarget.tagName, cls: clickTarget.className };
      }
      return { ok: false };
    }, target);

    if (clicked.ok) {
      log(`[OK] Selected training time "${target}" via ${clicked.tag}.${clicked.cls || ''}`);
      await page.waitForTimeout(500);
      const finalText = (await page
        .locator(`${comboSel} .baf-combobox-selected-item`)
        .first()
        .textContent()
        .catch(() => '') || '').trim();
      log(`Training time is now: "${finalText}"`);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `duration-selected-${ts()}.png`),
        fullPage: true,
      });
      return { picked: target };
    }
    log(`Option "${target}" not present — trying next preference.`);
  }

  log(`[WARN] Neither 120 nor 60 minutes selectable. See ${popupShot} for the open dropdown.`);
  return { picked: null, reason: 'no_match', options };
}

async function findDateColumn(page, targetDate, maxNextClicks = MAX_NEXT_WEEK_CLICKS) {
  const dateBoxSel = 'td.cp-calendar-date-box';
  const dateSel = `${dateBoxSel} .cp-calendar-date`;
  const nextBtnSel = 'td.cp-calendar-btn-next i[aria-label="Next week"]';

  await page.waitForSelector(dateSel, { timeout: 15000 });

  for (let attempt = 0; attempt <= maxNextClicks; attempt++) {
    const { index, dates } = await page.evaluate(
      ({ sel, target }) => {
        const boxes = Array.from(document.querySelectorAll(sel));
        const visibleDates = boxes.map((box) => {
          const el = box.querySelector('.cp-calendar-date');
          return el ? el.textContent.trim() : '';
        });
        return { index: visibleDates.indexOf(target), dates: visibleDates };
      },
      { sel: dateBoxSel, target: targetDate },
    );

    log(`Week ${attempt + 1}: visible dates [${dates.join(', ')}]`);

    if (index !== -1) {
      log(`[OK] Found "${targetDate}" at column index ${index}.`);
      return index;
    }

    if (attempt === maxNextClicks) {
      throw new Error(
        `Date "${targetDate}" not found after ${maxNextClicks} next-week clicks. Last visible: [${dates.join(', ')}]`,
      );
    }

    const nextBtn = page.locator(nextBtnSel).first();
    const canGoForward = await nextBtn.isVisible().catch(() => false);
    if (!canGoForward) {
      throw new Error(
        `Date "${targetDate}" not found and Next-week button is not available. Visible: [${dates.join(', ')}]`,
      );
    }

    const firstBefore = dates[0];
    log(`Date not in this week — clicking Next week (${attempt + 1}/${maxNextClicks})...`);
    await nextBtn.click();
    await page.waitForFunction(
      ({ sel, before }) => {
        const first = document.querySelector(`${sel} .cp-calendar-date`);
        return first && first.textContent.trim() !== before;
      },
      { sel: dateBoxSel, before: firstBefore },
      { timeout: 10000 },
    );
  }
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

    log(`Booking target — facility: "${FACILITY_TYPE}", date: "${BOOKING_DATE}", start: "${START_TIME}".`);

    await ensureOnFacilityBookingPage(page);
    await selectFacilityType(page, FACILITY_TYPE);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `facility-filtered-${ts()}.png`),
      fullPage: true,
    });

    const dateColumnIndex = await findDateColumn(page, BOOKING_DATE);
    log(`Date column index for "${BOOKING_DATE}" = ${dateColumnIndex} (use this to pick the time-slot column later).`);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `date-found-${ts()}.png`),
      fullPage: true,
    });

    await findAndBookTimeslot(page, START_TIME, dateColumnIndex);
  } catch (err) {
    log(`[ERROR] ${err.message}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `error-${ts()}.png`), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    log('Browser closed.');
  }
})();
