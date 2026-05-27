import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright";
import type { Config } from "./config";
import { logger } from "./logger";

const browserLogger = logger.child({ module: "browser" });

async function extractFirstPdfPage(pdfBuffer: Buffer): Promise<Buffer> {
  const sourcePdf = await PDFDocument.load(pdfBuffer);
  if (sourcePdf.getPageCount() === 0) {
    throw new Error("Downloaded bill PDF has no pages");
  }

  const firstPagePdf = await PDFDocument.create();
  const [firstPage] = await firstPagePdf.copyPages(sourcePdf, [0]);
  firstPagePdf.addPage(firstPage);

  return Buffer.from(await firstPagePdf.save());
}

export async function downloadBillFirstPagePdf(
  config: Config,
): Promise<Buffer> {
  browserLogger.info("Launching browser");
  const browser = await chromium.launch({ headless: false });
  const tempDir = await mkdtemp(join(tmpdir(), "utility-bill-"));

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
    });
    const page = await context.newPage();

    browserLogger.info("Opening COA utilities login");
    await page.goto("https://coautilities.com", {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("textbox", { name: "Username" })
      .fill(config.coautilitiesUsername);
    await page
      .getByRole("textbox", { name: "Password" })
      .fill(config.coautilitiesPassword);

    // Click login and wait for SAML redirect chain to complete
    browserLogger.info("Logging in");
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForURL("**opower.com/**", { timeout: 60000 });

    // login-success page redirects to the actual dashboard. Wait for that.
    await page.waitForURL((url) => url.pathname.endsWith("/dss/"), { timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    browserLogger.info("Landed on Opower dashboard");

    // Click VIEW BILL to open the billing page (it's a link, not a button, and
    // in all caps in the DOM). Skip actionability checks since the Opower page
    // may trigger background SAML refresh navs during interaction.
    await page.getByRole("link", { name: "VIEW BILL" }).click({ force: true });

    // Wait for the billing page to load — URL should be an Opower billing path.
    await page.waitForURL("**opower.com/**billing**", { timeout: 60000 });

    const downloadPromise = page.waitForEvent("download");
    browserLogger.info("Downloading bill PDF");
    await page
      .getByRole("button", { name: "View bill (PDF)", exact: true })
      .click();
    const download = await downloadPromise;

    const pdfPath = join(tempDir, "bill.pdf");
    await download.saveAs(pdfPath);

    const downloadedPdf = await readFile(pdfPath);
    const firstPagePdf = await extractFirstPdfPage(downloadedPdf);

    await context.close();
    browserLogger.info(
      { pdfBytes: firstPagePdf.length },
      "Extracted first page from bill PDF",
    );
    return firstPagePdf;
  } finally {
    await browser.close();
    await rm(tempDir, { recursive: true, force: true });
    browserLogger.info("Browser closed and temporary files removed");
  }
}
