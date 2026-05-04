import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "fs/promises";
import { PDFDocument } from "pdf-lib";
import { join } from "path";
import { tmpdir } from "os";
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

export async function downloadBillFirstPagePdf(config: Config): Promise<Buffer> {
  browserLogger.info("Launching browser");
  const browser = await chromium.launch({ headless: true });
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

    const downloadedPdf = await readFile(pdfPath);
    const firstPagePdf = await extractFirstPdfPage(downloadedPdf);

    await context.close();
    browserLogger.info(
      { pdfBytes: firstPagePdf.length },
      "Extracted first page from bill PDF"
    );
    return firstPagePdf;
  } finally {
    await browser.close();
    await rm(tempDir, { recursive: true, force: true });
    browserLogger.info("Browser closed and temporary files removed");
  }
}
