import type { Config } from "./config";
import { logger } from "./logger";
import type { BillData } from "./ocr";
import type { Dollars } from "./units";

interface TelegramSendDocumentResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number };
  };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

function buildBillTable(bill: BillData, roommateShareDollars: Dollars): string {
  const rows = bill.categories.map((cat) => {
    const name = cat.name.padEnd(22);
    const total = `$${cat.amountDollars.toFixed(2)}`.padStart(8);
    const share = `$${(cat.amountDollars / 2).toFixed(2)}`.padStart(8);
    return `${name}${total}  ${share}`;
  });
  const header = `${"Category".padEnd(22)}${"Total".padStart(8)}  ${"Your half".padStart(9)}`;
  const divider = "─".repeat(header.length);
  const footer = `${"TOTAL".padEnd(22)}${`$${bill.totalAmountDollars.toFixed(2)}`.padStart(8)}  ${`$${roommateShareDollars.toFixed(2)}`.padStart(9)}`;
  return [header, divider, ...rows, divider, footer].join("\n");
}

function buildYnabTransactionUrl(
  config: Config,
  transactionId: string,
): string {
  const budgetId = encodeURIComponent(config.ynabBudgetId);
  const accountId = encodeURIComponent(config.ynabAccountId);
  const encodedTransactionId = encodeURIComponent(transactionId);
  return `https://app.ynab.com/${budgetId}/accounts/${accountId}?modal=transaction-detail&transactionId=${encodedTransactionId}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createFallbackMoneyReminder(roommateShareDollars: Dollars): string {
  return `The YNAB split is done; send the money request for $${roommateShareDollars.toFixed(2)}.`;
}

async function answerCallbackQuery(
  config: Config,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/answerCallbackQuery`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Telegram answerCallbackQuery failed (${response.status}): ${body}`,
    );
  }
}

async function removeInlineKeyboard(
  config: Config,
  messageId: number,
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/editMessageReplyMarkup`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Telegram editMessageReplyMarkup failed (${response.status}): ${body}`,
    );
  }
}

export async function sendBillApprovalRequest(
  config: Config,
  bill: BillData,
  roommateShareDollars: Dollars,
  billPdfBuffer: Buffer,
  transactionId: string,
): Promise<number> {
  const telegramLogger = logger.child({
    module: "telegram",
    billDate: bill.billDate,
    dueDate: bill.dueDate,
    roommateShareDollars,
  });

  const table = buildBillTable(bill, roommateShareDollars);
  const caption =
    `Utility bill ready to split ✅\n` +
    `Due: ${bill.dueDate}\n\n` +
    `\`\`\`\n${table}\n\`\`\`\n\n` +
    `Press the button to split in YNAB and request $${roommateShareDollars.toFixed(2)} from your roommate.`;

  const replyMarkup = JSON.stringify({
    inline_keyboard: [
      [{ text: "✅ Split in YNAB", callback_data: `split:${transactionId}` }],
    ],
  });

  const form = new FormData();
  form.append("chat_id", config.telegramChatId);
  form.append(
    "document",
    new Blob([new Uint8Array(billPdfBuffer)], { type: "application/pdf" }),
    `utility-bill-${bill.billDate}.pdf`,
  );
  form.append("caption", caption);
  form.append("parse_mode", "Markdown");
  form.append("reply_markup", replyMarkup);

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendDocument`;
  telegramLogger.info("Sending Telegram bill approval request");
  const response = await fetch(url, { method: "POST", body: form });

  const json = (await response.json()) as TelegramSendDocumentResponse;
  if (!response.ok || !json.ok || !json.result) {
    throw new Error(
      `Telegram sendDocument failed (${response.status}): ${json.description ?? "unknown error"}`,
    );
  }

  telegramLogger.info(
    { messageId: json.result.message_id },
    "Telegram bill approval request sent",
  );
  return json.result.message_id;
}

export async function waitForSplitApproval(
  config: Config,
  transactionId: string,
  sentMessageId: number,
  timeoutMs: number = 24 * 60 * 60 * 1000,
): Promise<void> {
  const telegramLogger = logger.child({
    module: "telegram",
    transactionId,
    sentMessageId,
  });
  telegramLogger.info("Waiting for split approval callback");

  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const pollTimeoutSecs = Math.min(30, Math.floor(remainingMs / 1000));
    if (pollTimeoutSecs <= 0) break;

    const url =
      `https://api.telegram.org/bot${config.telegramBotToken}/getUpdates` +
      `?offset=${offset}&timeout=${pollTimeoutSecs}&allowed_updates=["callback_query"]`;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      (pollTimeoutSecs + 5) * 1000,
    );
    let json: TelegramGetUpdatesResponse;
    try {
      const response = await fetch(url, { signal: controller.signal });
      json = (await response.json()) as TelegramGetUpdatesResponse;
      if (!json.ok)
        throw new Error(`Telegram getUpdates failed: ${JSON.stringify(json)}`);
    } finally {
      clearTimeout(timer);
    }

    for (const update of json.result) {
      offset = Math.max(offset, update.update_id + 1);
      const cq = update.callback_query;
      if (
        cq?.data === `split:${transactionId}` &&
        cq.message?.message_id === sentMessageId
      ) {
        telegramLogger.info("Split approval received");
        await answerCallbackQuery(config, cq.id, "Splitting in YNAB...");
        await removeInlineKeyboard(config, sentMessageId);
        telegramLogger.info("Telegram approval button removed");
        return;
      }
      if (cq) {
        telegramLogger.info(
          { callbackData: cq.data },
          "Received unrelated callback, continuing poll",
        );
      }
    }
  }

  throw new Error(
    `waitForSplitApproval timed out after ${timeoutMs / 3_600_000}h for transaction ${transactionId}`,
  );
}

export async function sendSplitCompletedNotification(
  config: Config,
  _bill: BillData,
  roommateShareDollars: Dollars,
  transactionId: string,
  replyToMessageId: number,
): Promise<void> {
  const transactionUrl = buildYnabTransactionUrl(config, transactionId);
  const reminderMessage = createFallbackMoneyReminder(roommateShareDollars);
  const text =
    `${escapeHtml(reminderMessage)}\n\n` +
    `Transaction: <a href="${escapeHtml(transactionUrl)}">open in YNAB</a>`;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  logger.info(
    { module: "telegram", transactionId, replyToMessageId },
    "Sending Telegram split completion notification",
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "HTML",
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Telegram sendMessage failed (${response.status}): ${body}`,
    );
  }
  logger.info(
    { module: "telegram", transactionId },
    "Telegram split completion notification sent",
  );
}

export async function sendErrorNotification(
  config: Config,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const text = `Utility bill workflow failed ❌\n\`${message}\``;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  logger.info({ module: "telegram" }, "Sending Telegram error notification");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Telegram sendMessage failed (${response.status}): ${body}`,
    );
  }
  logger.info({ module: "telegram" }, "Telegram error notification sent");
}
