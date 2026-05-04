# CLAUDE.md

## Project overview

`utilities-splitter` is a TypeScript/Bun cron script that automates a shared utility bill workflow. It downloads the latest bill from coautilities.com, OCRs it with Qwen VL via OpenRouter, and manages the full YNAB transaction lifecycle — creating a scheduled transaction when a bill arrives, splitting it 50/50 once paid, and sending a Telegram reminder to request roommate reimbursement.

## Running the script

```sh
bun start          # bun src/main.ts
```

There is no build step; Bun runs TypeScript natively.

## Key files

| File | Responsibility |
|---|---|
| `src/main.ts` | Top-level orchestrator — all branching logic lives here |
| `src/browser.ts` | **Stub** — the user implements Playwright automation here |
| `src/ocr.ts` | Sends a bill screenshot to OpenRouter and parses the JSON response into `BillData` |
| `src/ynabClient.ts` | All YNAB API calls: search, create scheduled tx, split tx |
| `src/telegram.ts` | One function: POSTs a notification to the Telegram Bot API |
| `src/config.ts` | Merges `.env` secrets with `config.json` non-secret config into a `Config` object |
| `src/units.ts` | Branded `Dollars` and `Milliunits` types; conversion utilities |
| `config.json` | YNAB budget/account/category IDs and bill category → YNAB category mappings |

## Architecture notes

### Monetary types

All money is represented with one of two branded types from `src/units.ts`:

- `Dollars` — human-readable dollar amounts (e.g. `42.50`)
- `Milliunits` — YNAB's wire format (milliunits, negative for outflows; e.g. `-42500`)

Every variable holding a monetary value must be suffixed with its unit (`totalAmountDollars`, `halfAmountMilliunits`, etc.). Never pass a raw `number` where `Dollars` or `Milliunits` is expected.

### Configuration split

Secrets (credentials, API keys) live in `.env` and are never committed. Non-secret structured config (YNAB IDs, category mappings, model name) lives in `config.json` and is imported directly via TypeScript's `resolveJsonModule`. `src/config.ts` merges both into a single `Config` object.

### YNAB memo tag

Each bill is identified by the memo tag `[UTIL:{billDate}]` (e.g. `[UTIL:2026-04-01]`), where `billDate` is the issue date extracted by OCR. This tag is written to both scheduled and regular transactions and is used on every subsequent run to locate the right transaction without relying on amount or date alone.

### Deduplication

The script checks `isAlreadySplit(tx)` (`tx.subtransactions.length > 0`) before splitting or notifying. If subtransactions are already present, the bill was processed on a prior run and execution stops immediately. No external state file is needed.

### Split structure

For each itemized bill category (e.g. Electric $40):
- One subtransaction for **my half** (`$20`) → mapped YNAB category from `config.json`
- One subtransaction for **roommate's half** (`$20`) → `reimbursementsCategoryId`

The final subtransaction absorbs any cent-level rounding drift so the subtransaction sum always equals the parent transaction amount exactly (YNAB requirement).

### YNAB scheduled transaction frequency

Scheduled transactions are created with `frequency: "never"` — they are one-time entries, not recurring.

## Adding a new bill category

1. Add the category name (any case) and its YNAB category UUID to `config.json` under `categoryMappings`.
2. No code changes required — `config.ts` lowercases all keys at load time and `ynabClient.ts` matches case-insensitively.

## Implementing `src/browser.ts`

The function signature is:

```ts
export async function downloadBillAndScreenshot(config: Config): Promise<Buffer>
```

It must return a PNG `Buffer` of the first page of the latest bill. Typical implementation using Playwright:

1. `chromium.launch({ headless: true })`
2. Log in using `config.coautilitiesUsername` / `config.coautilitiesPassword`
3. Navigate to the billing section and trigger a PDF download
4. Open the downloaded PDF via a `file://` URL in a new page and call `page.screenshot()`
5. Return the screenshot buffer; clean up temp files

## Dependencies

| Package | Purpose |
|---|---|
| `ynab` | Official YNAB SDK (typed) |
| `openai` | OpenAI-compatible client used to call OpenRouter |
| `playwright` | Browser automation for bill download |
| `dotenv` | Load `.env` into `process.env` |
