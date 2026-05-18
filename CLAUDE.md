# Project Plan: Ultra-Fast PerfectGym Auto-Booker

## 1. Project Context & Strategy
- [cite_start]**Target Site:** `https://thekallang.perfectgym.com/clientportal2/#/Login` [cite: 49]
- [cite_start]**Target Server Location:** Melbourne, Australia (Micron21 Datacentre) [cite: 72]
- [cite_start]**Deployment Location:** BinaryLane VPS (Melbourne Region) to achieve sub-10ms latency[cite: 74, 79].
- [cite_start]**Core Strategy:** "The Speedster" — A Node.js + Playwright script focused on millisecond-precision timing and session persistence[cite: 7, 9].

## 2. Technical Stack
- [cite_start]**Runtime:** Node.js [cite: 9]
- [cite_start]**Automation Framework:** Playwright (with `playwright-extra` and `stealth` plugin) [cite: 9]
- [cite_start]**Timing:** `node-ntp-client` for synchronization with Australian NTP servers[cite: 10, 84].
- [cite_start]**Notifications:** Discord/Telegram Webhook for success alerts and payment links[cite: 35].

---

## 3. BinaryLane VPS Setup Steps
To ensure the bot runs "next door" to the target server, follow these steps to set up your Melbourne VPS:

1.  **Account Creation:** Sign up at [BinaryLane](https://www.binarylane.com.au/).
2.  **Create Server:**
    * [cite_start]**Region:** Select **Melbourne** (Crucial for low latency)[cite: 73, 78].
    * [cite_start]**Plan:** The base plan (1GB RAM) is sufficient for a headless Playwright bot[cite: 78].
    * **OS:** Choose **Ubuntu 22.04 LTS** or later.
3.  **Access & Environment:**
    * Connect to your VPS via SSH (e.g., `ssh root@your_vps_ip`).
    * Update the system: `sudo apt update && sudo apt upgrade -y`.
    * Install Node.js: `curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt install -y nodejs`.
4.  **Install Bot Dependencies:**
    * Install Playwright system dependencies: `npx playwright install-deps`.

---

## 4. Claude Code Development Directions
When you prompt Claude Code to build the script, provide this specific "Server Context" to ensure the logic is optimized for the Melbourne environment.

### The "Context" Prompt for Claude:
> "I am building an auto-booking bot for a PerfectGym portal hosted in Melbourne, Australia. The script will run on a BinaryLane VPS in the same city. 
> 
> Please ensure the code:
> [cite_start]1.  **Syncs with Melbourne NTP Servers:** Use `au.pool.ntp.org` to align the bot's internal clock with the target server[cite: 10, 84].
> [cite_start]2.  **Handles Session Timing:** Logs in exactly 1 minute before the slot opens[cite: 64, 65].
> [cite_start]3.  **Executes Precision Clicks:** Uses a high-frequency loop starting 10 seconds before the slot to monitor the 'Book' button's state[cite: 12, 26].
> [cite_start]4.  **Stealth:** Uses Playwright Stealth to avoid detection by PerfectGym's anti-bot measures[cite: 4, 9].
> [cite_start]5.  **Output:** Captures the redirected payment URL after a successful booking and sends it via Webhook[cite: 20, 42]."

---

## 5. Development Milestones
1.  [cite_start]**Phase 1: Selector Identification:** Manually inspect the site to find the CSS selectors for the Login fields, the specific timeslot, and the final 'Book' button[cite: 30, 68].
2.  **Phase 2: Script Generation:** Use Claude Code to generate the `booking.js` script using the provided context.
3.  **Phase 3: Latency Testing:** Run a test script on the VPS to measure the round-trip time to `thekallang.perfectgym.com`.
4.  **Phase 4: Dry Run:** Test the login and navigation flow 10 minutes before the actual booking window opens.
5.  [cite_start]**Phase 5: Live Execution:** Schedule the bot to trigger 1 minute before the slot opening time[cite: 18, 65].