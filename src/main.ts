import { Temporal } from "@js-temporal/polyfill";
import { downloadBillFirstPagePdf } from "./browser";
import { loadConfig } from "./config";
import { logger } from "./logger";
import { extractBillData } from "./ocr";
import { computePdfHash, loadState, saveState } from "./state";
import type { Dollars } from "./units";
import { YNABClient } from "./ynabClient";

/** Max days we consider a previously seen bill to still be "current". */
const BILL_CYCLE_DAYS = 35;

async function main(): Promise<void> {
  logger.info("Starting utility bill workflow");

  const config = loadConfig();
  const ynabClient = new YNABClient(config);
  const state = await loadState();

  // ── Gate 1: State check — skip browser + LLM if last bill is still current ──
  if (state.lastBillDate !== null) {
    const lastBillDate = Temporal.PlainDate.from(state.lastBillDate);
    const today = Temporal.Now.plainDateISO();
    const daysSinceLastBill = lastBillDate.until(today).days;

    if (daysSinceLastBill <= BILL_CYCLE_DAYS) {
      logger.info(
        { lastBillDate: state.lastBillDate, daysSinceLastBill },
        "Gate 1: Last bill is recent — checking YNAB",
      );

      const memoTag = `[UTIL:${state.lastBillDate}]`;

      // Check both scheduled and regular transactions for the last known memo tag.
      const [existingScheduled, existingRegular] = await Promise.all([
        ynabClient.findScheduledTransaction(memoTag),
        ynabClient.findRecentTransactionByMemo(memoTag),
      ]);

      if (existingScheduled !== null) {
        logger.info(
          { lastBillDate: state.lastBillDate, scheduledTransactionId: existingScheduled.id },
          "Gate 1: Scheduled transaction already exists for last known bill — nothing to do",
        );
        return;
      }

      if (existingRegular !== null) {
        if (ynabClient.isAlreadySplit(existingRegular)) {
          logger.info(
            { lastBillDate: state.lastBillDate, transactionId: existingRegular.id },
            "Gate 1: Bill already split — nothing to do",
          );
          return;
        }
        // Regular transaction exists but isn't split yet — proceed to Gate 3
        // with the PDF we already have. But we don't have the PDF stored, so we
        // need to re-download it for the Telegram approval flow.
        // Fall through to Gate 2.
        logger.info(
          { lastBillDate: state.lastBillDate, transactionId: existingRegular.id },
          "Gate 1: Unsplit regular transaction found — moving to Gate 2 for PDF",
        );
      }
    } else {
      logger.info(
        { lastBillDate: state.lastBillDate, daysSinceLastBill },
        `Gate 1: Last bill is more than ${BILL_CYCLE_DAYS} days old — new bill may be available`,
      );
    }
  } else {
    logger.info("Gate 1: No previous bill state — proceeding to download");
  }

  // ── Gate 2: PDF hash check — skip LLM if PDF content hasn't changed ──
  logger.info("Gate 2: Downloading latest bill PDF");
  const billPdfBuffer = await downloadBillFirstPagePdf(config);
  const pdfHash = computePdfHash(billPdfBuffer);

  logger.info(
    { pdfBytes: billPdfBuffer.length, pdfHash: pdfHash.slice(0, 16) + "…" },
    "Downloaded bill PDF",
  );

  if (state.lastPdfHash !== null && pdfHash === state.lastPdfHash) {
    logger.info(
      { pdfHash: pdfHash.slice(0, 16) + "…" },
      "Gate 2: PDF hash matches last run — bill hasn't changed, skipping OCR",
    );
    return;
  }

  // ── Gate 3: OCR — only reached if PDF is genuinely new ──
  logger.info("Gate 3: PDF has changed — extracting bill data with OCR");
  const bill = await extractBillData(billPdfBuffer, config);

  // Save state so future runs can skip Gates 2 and 3.
  await saveState({
    lastBillDate: bill.billDate,
    lastPdfHash: pdfHash,
  });

  const memoTag = `[UTIL:${bill.billDate}]`;
  const todayStr = Temporal.Now.plainDateISO().toString();
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
    "Extracted bill data",
  );

  const [regularTx, scheduledTx] = await Promise.all([
    ynabClient.findRegularTransaction(memoTag, bill.dueDate),
    ynabClient.findScheduledTransaction(memoTag),
  ]);

  if (regularTx) {
    workflowLogger.info(
      { transactionId: regularTx.id },
      "Found regular transaction",
    );
    if (ynabClient.isAlreadySplit(regularTx)) {
      workflowLogger.info("Bill already split; nothing to do");
      return;
    }
    const roommateShareDollars = (bill.totalAmountDollars / 2) as Dollars;
    const billJson = JSON.stringify({
      transactionId: regularTx.id,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      totalAmountDollars: bill.totalAmountDollars,
      roommateShareDollars,
      categories: bill.categories,
    });
    console.log(`CLEARED_TX_FOUND: ${billJson}`);
    workflowLogger.info(
      { transactionId: regularTx.id, roommateShareDollars },
      "Cleared transaction found — output for Hermes relay",
    );
    return;
  }

  if (scheduledTx) {
    workflowLogger.info(
      { scheduledTransactionId: scheduledTx.id },
      "Found scheduled transaction",
    );
    if (bill.dueDate > todayStr) {
      workflowLogger.info("Scheduled transaction already exists");
    } else {
      workflowLogger.warn("Bill is past due but not yet entered in YNAB");
    }
    return;
  }

  if (bill.dueDate > todayStr) {
    await ynabClient.createScheduledTransaction(
      bill.dueDate,
      bill.totalAmountDollars,
      memoTag,
    );
    workflowLogger.info("Created scheduled transaction");
  } else {
    workflowLogger.warn(
      "No transaction found and bill due date has already passed",
    );
  }
}

main().catch((err) => {
  logger.error({ err }, "Utility bill workflow failed");
  process.exit(1);
});
