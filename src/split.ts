import { loadConfig } from "./config";
import { logger } from "./logger";
import type { BillData } from "./ocr";
import { YNABClient } from "./ynabClient";

/**
 * Standalone split runner for Hermes to call when the user approves.
 *
 * Usage:
 *   bun src/split.ts <transactionId> '<bill-json>'
 *
 * bill-json format:
 * {
 *   "billDate": "2026-05-06",
 *   "dueDate": "2026-05-26",
 *   "totalAmountDollars": 253.50,
 *   "categories": [{"name": "electric", "amountDollars": 109.81}, ...]
 * }
 */

async function main(): Promise<void> {
  const txId = process.argv[2];
  const billJson = process.argv[3];

  if (!txId || !billJson) {
    console.error("Usage: bun src/split.ts <transactionId> '<bill-json>'");
    process.exit(1);
  }

  let bill: BillData;
  try {
    bill = JSON.parse(billJson) as BillData;
  } catch {
    console.error("Failed to parse bill JSON");
    process.exit(1);
  }

  if (
    !bill.billDate ||
    !bill.dueDate ||
    !bill.totalAmountDollars ||
    !Array.isArray(bill.categories)
  ) {
    console.error("bill-json is missing required fields");
    process.exit(1);
  }

  const config = loadConfig();
  const ynabClient = new YNABClient(config);

  logger.info(
    { transactionId: txId, billDate: bill.billDate },
    "Running split via Hermes relay",
  );

  await ynabClient.splitTransaction(txId, bill, config);

  logger.info(
    { transactionId: txId, billDate: bill.billDate },
    "Split completed via Hermes relay",
  );
  console.log(`SPLIT_COMPLETE: ${txId}`);
}

main().catch((err) => {
  logger.error({ err }, "Split via Hermes relay failed");
  console.error(
    `SPLIT_FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
