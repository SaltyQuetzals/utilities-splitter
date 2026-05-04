import { loadConfig } from "./config";
import { downloadBillAndScreenshot } from "./browser";
import { extractBillData } from "./ocr";
import { YNABClient } from "./ynabClient";
import { sendBillNotification } from "./telegram";
import type { Dollars } from "./units";

async function main(): Promise<void> {
  const config = loadConfig();
  const ynabClient = new YNABClient(config);

  const screenshotBuffer = await downloadBillAndScreenshot(config);
  const bill = await extractBillData(screenshotBuffer, config);

  const memoTag = `[UTIL:${bill.billDate}]`;
  const todayStr = new Date().toISOString().slice(0, 10);

  const [regularTx, scheduledTx] = await Promise.all([
    ynabClient.findRegularTransaction(memoTag, bill.billDate),
    ynabClient.findScheduledTransaction(memoTag),
  ]);

  if (regularTx) {
    if (ynabClient.isAlreadySplit(regularTx)) {
      // Already processed on a previous run — no duplicate split or notification.
      console.log(`Bill ${bill.billDate} already split. Nothing to do.`);
      return;
    }
    // Step 8: Bill entered in YNAB for the first time — split and notify.
    await ynabClient.splitTransaction(regularTx.id, bill, config);
    const roommateShareDollars = (bill.totalAmountDollars / 2) as Dollars;
    await sendBillNotification(config, bill, roommateShareDollars);
    console.log(
      `Bill ${bill.billDate} split. Telegram sent. Roommate owes $${roommateShareDollars.toFixed(2)}.`
    );
    return;
  }

  if (scheduledTx) {
    if (bill.dueDate > todayStr) {
      // Step 7: Future bill already scheduled — nothing to do.
      console.log(`Scheduled transaction for ${bill.dueDate} already exists.`);
    } else {
      // Edge case: past due but not yet entered in YNAB by the user.
      console.warn(
        `Bill due ${bill.dueDate} is past due but not yet entered in YNAB.`
      );
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
    console.log(
      `Created scheduled transaction for ${bill.dueDate}: $${bill.totalAmountDollars.toFixed(2)}.`
    );
  } else {
    console.warn(
      `No transaction found and bill due date ${bill.dueDate} has already passed.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
