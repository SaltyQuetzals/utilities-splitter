# AGENTS.md

## Project overview

`utilities-splitter` is a TypeScript/Bun cron script that automates a shared utility bill workflow. It downloads the latest bill from coautilities.com, OCRs it with Qwen VL via OpenRouter, and manages the full YNAB transaction lifecycle — creating a scheduled transaction when a bill arrives, and once the bill clears, sending a Telegram PDF document with an inline approval button. The YNAB split only executes after the user presses the button.

## Running the script

```sh
bun start          # bun src/main.ts
```

There is no build step; Bun runs TypeScript natively.

## Key files

| File | Responsibility |
|---|---|
| `src/main.ts` | Top-level orchestrator — all branching logic lives here |
| `src/browser.ts` | Logs in to coautilities.com, downloads the latest bill PDF, extracts the first page, and returns it as a `Buffer` |
| `src/ocr.ts` | Sends the first-page bill PDF to OpenRouter and parses the JSON response into `BillData` |
| `src/ynabClient.ts` | All YNAB API calls: search, create scheduled tx, split tx |
| `src/telegram.ts` | `sendBillApprovalRequest` (PDF document + inline button via `sendDocument` multipart), `waitForSplitApproval` (long-polls `getUpdates` until the button is pressed), and split completion/error notifications |
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

### Telegram approval flow

When a regular (cleared) transaction is found that has not yet been split, the script:

1. Sends the first-page PDF to Telegram via `sendDocument` multipart with an inline keyboard button (`callback_data: "split:{transactionId}"`) and returns the `message_id`
2. Long-polls `getUpdates` (30-second Telegram timeout per iteration, 24-hour overall deadline) until a `callback_query` arrives that matches **both** the `callback_data` and the `message_id` of the message just sent — matching on `message_id` prevents stale callbacks from a failed prior run from triggering a split
3. Answers the callback query, removes the inline button from the Telegram message, then calls `splitTransaction`
4. Sends a Telegram confirmation message after the YNAB split succeeds

If the 24-hour deadline expires without a button press, the script throws and exits non-zero. The next cron run will re-send the approval request (the transaction is still unsplit).

The script uses Telegram's long-poll (`getUpdates`) API. An active Telegram webhook is incompatible with this approach and must be removed before running.

### Deduplication

The script checks `isAlreadySplit(tx)` (`tx.subtransactions.length > 0`) before the approval flow. If subtransactions are already present, the bill was processed on a prior run and execution stops immediately. No external state file is needed.

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

## `src/browser.ts` exports

| Export | Description |
|---|---|
| `downloadBillFirstPagePdf(config)` | Logs in to coautilities.com, downloads the latest bill PDF, extracts the first page, and returns it as a `Buffer` |

The function manages its own browser lifecycle (launch → close in `finally`) and cleans up any temp files.

## Dependencies

| Package | Purpose |
|---|---|
| `ynab` | Official YNAB SDK (typed) |
| `@openrouter/sdk` | Official OpenRouter SDK for calling LLMs via OpenRouter |
| `playwright` | Browser automation for bill download |
| `dotenv` | Load `.env` into `process.env` |
