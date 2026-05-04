import "dotenv/config";
import appConfig from "../config.json";

export interface Config {
  coautilitiesUsername: string;
  coautilitiesPassword: string;
  ynabApiKey: string;
  ynabBudgetId: string;
  ynabAccountId: string;
  ynabReimbursementsCategoryId: string;
  openrouterApiKey: string;
  openrouterModel: string;
  telegramBotToken: string;
  telegramChatId: string;
  categoryMappings: Record<string, string>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    coautilitiesUsername: requireEnv("COAUTILITIES_USERNAME"),
    coautilitiesPassword: requireEnv("COAUTILITIES_PASSWORD"),
    ynabApiKey: requireEnv("YNAB_API_KEY"),
    ynabBudgetId: appConfig.ynab.budgetId,
    ynabAccountId: appConfig.ynab.accountId,
    ynabReimbursementsCategoryId: appConfig.ynab.reimbursementsCategoryId,
    openrouterApiKey: requireEnv("OPENROUTER_API_KEY"),
    openrouterModel: appConfig.openrouterModel,
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnv("TELEGRAM_CHAT_ID"),
    categoryMappings: Object.fromEntries(
      Object.entries(appConfig.categoryMappings).map(([k, v]) => [k.toLowerCase(), v])
    ),
  };
}
