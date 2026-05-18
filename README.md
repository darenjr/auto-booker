# auto-booker

Ultra-fast PerfectGym auto-booker bot. See `CLAUDE.md` for the full project plan.

## Local quickstart

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then edit .env with your real credentials
npm run login          # headless run
npm run login:headed   # watch it in a visible browser (local debug only)
```

A successful run saves session cookies to `auth-state.json` and screenshots to `screenshots/`.

## BinaryLane VPS deploy (Melbourne)

```bash
# on the VPS
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs git
git clone <this-repo> && cd auto-booker
npm install
npx playwright install --with-deps chromium
nano .env              # paste credentials
npm run login          # should run headless and report [OK]
```

If `[OK]` is logged and `auth-state.json` is written, Phase 1 (login) is working.
