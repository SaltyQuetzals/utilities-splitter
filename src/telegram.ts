import type { Config } from "./config";
import type { BillData } from "./ocr";
import type { Dollars } from "./units";

export async function sendBillNotification(
  config: Config,
  bill: BillData,
  roommateShareDollars: Dollars
): Promise<void> {
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
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed (${response.status}): ${body}`);
  }
}
