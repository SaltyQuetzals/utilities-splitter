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

  // NOTE: updateMetadata MUST be false here. pdf-lib's default (true) injects
  // a fresh /CreationDate + /ModDate (current wall clock) into the document
  // Info dict on every create/save, which makes the re-serialized bytes differ
  // every run — defeating the Gate 2 hash check (OCR ran every day despite an
  // unchanged bill). Disabling metadata makes extraction byte-stable for
  // identical input.
  const firstPagePdf = await PDFDocument.create({ updateMetadata: false });
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
    await page.waitForURL((url) => url.pathname.endsWith("/dss/"), {
      timeout: 30000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30000 });
    browserLogger.info("Landed on Opower dashboard");

    // Click VIEW BILL to open the billing page (it's a link, not a button, and
    // in all caps in the DOM). Skip actionability checks since the Opower page
    // may trigger background SAML refresh navs during interaction.
    //
    // networkidle doesn't guarantee the billing content chunk rendered — the
    // dashboard shell can load while a background SAML nav rebuilds the DOM,
    // leaving the VIEW BILL link absent for a while (observed 2026-09-03:
    // login + dashboard OK, link missing for a full 30s, daily run failed).
    // Retry with a fresh 30s wait per attempt before giving up.
    const viewBillAttempts = 3;
    const viewBillRetryDelayMs = 5_000;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await page
          .getByRole("link", { name: "VIEW BILL" })
          .click({ force: true });
        break;
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        if (attempt >= viewBillAttempts || !isTimeout) throw err;
        browserLogger.warn(
          {
            attempt,
            maxAttempts: viewBillAttempts,
            retryDelayMs: viewBillRetryDelayMs,
          },
          "VIEW BILL link not ready — retrying",
        );
        await new Promise((resolve) =>
          setTimeout(resolve, viewBillRetryDelayMs),
        );
      }
    }

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
