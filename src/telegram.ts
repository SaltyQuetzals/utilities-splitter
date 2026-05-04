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
  const rows = bill.categories.map((cat) => {
    const name = cat.name.padEnd(22);
    const total = `$${cat.amountDollars.toFixed(2)}`.padStart(8);
    const share = `$${(cat.amountDollars / 2).toFixed(2)}`.padStart(8);
    return `${name}${total}  ${share}`;
  });
  const header = `${"Category".padEnd(22)}${"Total".padStart(8)}  ${"Your half".padStart(9)}`;
  const divider = "─".repeat(header.length);
  const footer = `${"TOTAL".padEnd(22)}${`$${bill.totalAmountDollars.toFixed(2)}`.padStart(8)}  ${`$${roommateShareDollars.toFixed(2)}`.padStart(9)}`;
  const table = [header, divider, ...rows, divider, footer].join("\n");

  const text =
    `Utility bill paid ✅\n` +
    `Due: ${bill.dueDate}\n\n` +
    `\`\`\`\n${table}\n\`\`\`\n\n` +
    `Please Venmo request $${roommateShareDollars.toFixed(2)} from your roommate.`;

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  notificationLogger.info("Sending Telegram bill notification");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: "Markdown" }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }

  notificationLogger.info("Telegram bill notification sent");
}
