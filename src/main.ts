import { loadConfig } from "./config";
import { downloadBillFirstPagePdf } from "./browser";
import { extractBillData } from "./ocr";
import { YNABClient } from "./ynabClient";
import { sendBillNotification } from "./telegram";
import { logger } from "./logger";
import type { Dollars } from "./units";

async function main(): Promise<void> {
  logger.info("Starting utility bill workflow");
  const config = loadConfig();
  const ynabClient = new YNABClient(config);

  logger.info("Downloading latest bill PDF");
  const billPdfBuffer = await downloadBillFirstPagePdf(config);
  logger.info({ pdfBytes: billPdfBuffer.length }, "Downloaded bill PDF");

  logger.info("Extracting bill data with OCR");
  const bill = await extractBillData(billPdfBuffer, config);

  const memoTag = `[UTIL:${bill.billDate}]`;
  const todayStr = new Date().toISOString().slice(0, 10);
  const workflowLogger = logger.child({
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    totalAmountDollars: bill.totalAmountDollars,
    memoTag,
  });

  workflowLogger.info(
    {
      categoryCount: bill.categories.length,
      categories: bill.categories.map((category) => ({
        name: category.name,
        amountDollars: category.amountDollars,
      })),
    },
    "Extracted bill data"
  );

  const [regularTx, scheduledTx] = await Promise.all([
    ynabClient.findRegularTransaction(memoTag, bill.dueDate),
    ynabClient.findScheduledTransaction(memoTag),
  ]);

  if (regularTx) {
    workflowLogger.info(
      { transactionId: regularTx.id },
      "Found regular transaction"
    );
    if (ynabClient.isAlreadySplit(regularTx)) {
      // Already processed on a previous run — no duplicate split or notification.
      workflowLogger.info("Bill already split; nothing to do");
      return;
    }
    // Step 8: Bill entered in YNAB for the first time — split and notify.
    await ynabClient.splitTransaction(regularTx.id, bill, config);
    const roommateShareDollars = (bill.totalAmountDollars / 2) as Dollars;
    await sendBillNotification(config, bill, roommateShareDollars);
    workflowLogger.info(
      { transactionId: regularTx.id, roommateShareDollars },
      "Bill split and Telegram notification sent"
    );
    return;
  }

  if (scheduledTx) {
    workflowLogger.info(
      { scheduledTransactionId: scheduledTx.id },
      "Found scheduled transaction"
    );
    if (bill.dueDate > todayStr) {
      // Step 7: Future bill already scheduled — nothing to do.
      workflowLogger.info("Scheduled transaction already exists");
    } else {
      // Edge case: past due but not yet entered in YNAB by the user.
      workflowLogger.warn("Bill is past due but not yet entered in YNAB");
    }
    return;
  }

  if (bill.dueDate > todayStr) {
    // Step 6: No transaction yet — create a scheduled one.
    await ynabClient.createScheduledTransaction(
      bill.dueDate,
      bill.totalAmountDollars,
      memoTag
    );
    workflowLogger.info("Created scheduled transaction");
  } else {
    workflowLogger.warn(
      "No transaction found and bill due date has already passed"
    );
  }
}

main().catch((err) => {
  logger.error({ err }, "Utility bill workflow failed");
  process.exit(1);
});
