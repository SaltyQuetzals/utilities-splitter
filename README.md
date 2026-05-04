# utilities-splitter

A daily cron script that automates the full lifecycle of a shared utility bill:

1. Downloads the latest bill PDF from [coautilities.com](https://coautilities.com) via Playwright
2. OCRs the first page using Qwen 2.5 VL (via OpenRouter) to extract itemized categories and the total
3. Checks YNAB for an existing transaction matching the bill
4. Creates a scheduled transaction when a new bill is detected
5. Once the bill clears in YNAB, sends a Telegram message with the bill PDF and an inline **"✅ Split in YNAB"** button
6. When you press the button, splits the transaction 50/50 across your utility categories and a Reimbursements category

Subsequent runs are idempotent — once a transaction has been split, no further action is taken.

---

## Requirements

- [Bun](https://bun.sh) >= 1.0
- A YNAB account with a [personal access token](https://api.ynab.com/#personal-access-tokens)
- An [OpenRouter](https://openrouter.ai) API key
- A [Telegram bot token](https://core.telegram.org/bots#botfather) and your chat ID

---

## Setup

### 1. Install dependencies

```sh
bun install
bunx playwright install chromium
```

### 2. Configure secrets

Copy `.env.example` to `.env` and fill in your credentials:

```sh
cp .env.example .env
```

| Variable | Description |
|---|---|
| `COAUTILITIES_USERNAME` | Your coautilities.com login username |
| `COAUTILITIES_PASSWORD` | Your coautilities.com login password |
| `YNAB_API_KEY` | YNAB personal access token |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram user or chat ID |

### 3. Configure YNAB IDs and category mappings

Edit `config.json` with your budget, account, and category UUIDs. You can find these in the YNAB web app URL or via the [YNAB API](https://api.ynab.com/v1#/Budgets/getBudgets).

To list the IDs available to your `YNAB_API_KEY`, run:

```sh
bun run ynab:ids
```

To show accounts and categories for only one budget:

```sh
bun run ynab:ids --budget <budget-id>
```

```jsonc
{
  "openrouterModel": "qwen/qwen-2.5-vl-7b-instruct",
  "ynab": {
    "budgetId": "...",          // Budget to operate on
    "accountId": "...",         // Account the utility bill is paid from
    "reimbursementsCategoryId": "..."  // Category for your roommate's half
  },
  "categoryMappings": {
    // Maps bill category names (case-insensitive) → YNAB category IDs
    "Electric": "...",
    "Gas": "...",
    "Water": "..."
  }
}
```

### 4. Enable inline keyboard callbacks on your Telegram bot

The bot sends an inline button with the bill message. For the button to fire a callback that this script can receive, ensure your bot **has not** set a webhook (`deleteWebhook` if needed). The script uses Telegram's long-poll `getUpdates` API, which is incompatible with an active webhook.

---

## Running

```sh
bun start
```

Logs are emitted as structured JSON through `pino`. Set `LOG_LEVEL` to adjust
verbosity:

```sh
LOG_LEVEL=debug bun start
```

### Cron

To run once a day at 8 AM:

```cron
0 8 * * * cd /path/to/utilities-splitter && bun src/main.ts >> /var/log/utilities-splitter.log 2>&1
```

---

## How the decision logic works

Each run, the script extracts a `billDate` from the OCR result and looks for a memo tag `[UTIL:{billDate}]` in both YNAB scheduled transactions and regular (cleared) transactions.

| Situation | Action |
|---|---|
| No transaction found, due date in the future | Create a scheduled transaction |
| Scheduled transaction found, due date in the future | Nothing to do |
| Scheduled transaction found, due date has passed | Warn — bill is past due but not yet entered in YNAB |
| Regular transaction found, not yet split | Send Telegram PDF with inline approval button; split 50/50 once button is pressed |
| Regular transaction found, already split | Nothing to do (deduplication) |

---

## Project structure

```
src/
  main.ts         Decision logic orchestrator
  browser.ts      COA download automation
  ocr.ts          OpenRouter Qwen VL bill extraction
  ynabClient.ts   YNAB API wrapper
  telegram.ts     Telegram PDF + inline button approval flow
  config.ts       Config loader (.env + config.json)
  logger.ts       Shared pino logger
  units.ts        Branded Dollars/Milliunits types
config.json       Non-secret config: YNAB IDs, category mappings
.env.example      Secret environment variable template
```
