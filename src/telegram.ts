import type { Config } from "./config";
import { logger } from "./logger";
import type { BillData } from "./ocr";
import type { Dollars } from "./units";

export async function sendBillNotification(
  config: Config,
  bill: BillData,
  roommateShareDollars: Dollars
): Promise<void> {
  const notificationLogger = logger.child({
    module: "telegram",
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    roommateShareDollars,
  });
  const breakdown = bill.categories
    .map(
      (cat) =>
        `  ${cat.name.padEnd(12)} $${cat.amountDollars.toFixed(2).padStart(7)}  (your share: $${(cat.amountDollars / 2).toFixed(2)})`
    )
    .join("\n");

  const text =
    `Utility bill paid ✓\n` +
    `Due: ${bill.dueDate} | Total: $${bill.totalAmountDollars.toFixed(2)}\n\n` +
    `Breakdown:\n${breakdown}\n\n` +
    `Please Venmo request $${roommateShareDollars.toFixed(2)} from your roommate.`;

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  notificationLogger.info("Sending Telegram bill notification");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }

  notificationLogger.info("Telegram bill notification sent");
}
