import "dotenv/config";
import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "utilities-splitter",
  },
  redact: {
    paths: [
      "config.coautilitiesPassword",
      "config.ynabApiKey",
      "config.openrouterApiKey",
      "config.telegramBotToken",
      "telegramBotToken",
      "ynabApiKey",
      "openrouterApiKey",
    ],
    remove: true,
  },
});
