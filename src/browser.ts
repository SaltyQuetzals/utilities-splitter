import type { Config } from "./config";

/**
 * Log in to coautilities.com, download the latest bill PDF, and return a PNG
 * screenshot of its first page as a Buffer.
 *
 * Implementation left to the user — fill in Playwright selectors and navigation
 * logic specific to the coautilities.com UI.
 */
export async function downloadBillAndScreenshot(_config: Config): Promise<Buffer> {
  throw new Error("Not implemented");
}
