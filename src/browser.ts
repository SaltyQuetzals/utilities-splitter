import { chromium } from "playwright";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Config } from "./config";
import { logger } from "./logger";

const browserLogger = logger.child({ module: "browser" });

export async function downloadBillAndScreenshot(
  config: Config
): Promise<Buffer> {
  browserLogger.info("Launching browser");
  const browser = await chromium.launch({ headless: true });
  const tempDir = await mkdtemp(join(tmpdir(), "utility-bill-"));

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
    });
    const page = await context.newPage();

    browserLogger.info("Opening COA utilities login");
    await page.goto("https://coautilities.com/wps/wcm/connect/occ/coa/home");
    await page
      .getByRole("textbox", { name: "Username" })
      .fill(config.coautilitiesUsername);
    await page
      .getByRole("textbox", { name: "Password" })
      .fill(config.coautilitiesPassword);
    await page.getByRole("button", { name: "Log in" }).click();

    browserLogger.info("Opening billing overview");
    await page.goto("https://dss-coa.opower.com/dss/overview");
    await page.getByRole("link", { name: "View bill" }).click();

    const downloadPromise = page.waitForEvent("download");
    browserLogger.info("Downloading bill PDF");
    await page
      .getByRole("button", { name: "View bill (pdf)", exact: true })
      .click();
    const download = await downloadPromise;

    const pdfPath = join(tempDir, "bill.pdf");
    await download.saveAs(pdfPath);

    const pdfPage = await context.newPage();
    await pdfPage.goto(`file://${pdfPath}`);
    // Allow the PDF renderer to finish painting before capturing
    await pdfPage.waitForTimeout(1000);

    const screenshot = await pdfPage.screenshot({ type: "png" });

    await context.close();
    browserLogger.info(
      { screenshotBytes: screenshot.length },
      "Captured bill screenshot"
    );
    return screenshot;
  } finally {
    await browser.close();
    await rm(tempDir, { recursive: true, force: true });
    browserLogger.info("Browser closed and temporary files removed");
  }
}
