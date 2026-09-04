import { OpenRouter } from "@openrouter/sdk";
import { z } from "zod";
import type { Config } from "./config";
import { logger } from "./logger";
import { withRetries } from "./retry";
import { type Dollars, dollars } from "./units";

interface BillCategory {
  name: string;
  amountDollars: Dollars;
}

export interface BillData {
  /** YYYY-MM-DD — used as the unique memo key in YNAB. */
  billDate: string;
  /** YYYY-MM-DD */
  dueDate: string;
  totalAmountDollars: Dollars;
  categories: BillCategory[];
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

function createOcrResponseSchema(config: Config) {
  const categoryNames = Object.keys(config.categoryMappings);
  if (categoryNames.length === 0) {
    throw new Error("No bill category mappings configured");
  }

  const categoryNameSchema = z.enum(categoryNames as [string, ...string[]]);

  return z.strictObject({
    bill_date: dateSchema.describe(
      "Bill issue date in YYYY-MM-DD format. This identifies the bill.",
    ),
    due_date: dateSchema.describe("Payment due date in YYYY-MM-DD format."),
    total_amount: z
      .number()
      .nonnegative()
      .describe("Total amount due in dollars, without a currency symbol."),
    categories: z
      .array(
        z.strictObject({
          name: categoryNameSchema.describe(
            "Bill category name. Must exactly match one configured category mapping.",
          ),
          amount: z
            .number()
            .nonnegative()
            .describe(
              "Category charge amount in dollars, without a currency symbol.",
            ),
        }),
      )
      .min(1)
      .describe("Itemized bill categories that add up to the total amount."),
  });
}

function createExtractionPrompt(config: Config): string {
  const categoryNames = Object.keys(config.categoryMappings).join(", ");
  return `You are extracting structured data from a utility bill PDF.

Return a JSON object with exactly these fields:
- bill_date: the bill issue date in YYYY-MM-DD format
- due_date: the payment due date in YYYY-MM-DD format
- total_amount: the total amount due as a number (dollars, no currency symbol)
- categories: an array of objects, each with:
  - name: the category/service name; use exactly one of these configured category names: ${categoryNames}
  - amount: the charge amount as a number (dollars, no currency symbol)

Return only valid JSON. Do not include any explanation or markdown.`;
}

export async function extractBillData(
  billPdfBuffer: Buffer,
  config: Config,
): Promise<BillData> {
  const ocrLogger = logger.child({
    module: "ocr",
    model: config.openrouterModel,
    pdfBytes: billPdfBuffer.length,
  });
  const client = new OpenRouter({ apiKey: config.openrouterApiKey });
  const ocrResponseSchema = createOcrResponseSchema(config);
  const jsonSchema = z.toJSONSchema(ocrResponseSchema);

  const b64 = billPdfBuffer.toString("base64");

  ocrLogger.info("Sending bill PDF to OpenRouter");
  const response = await withRetries(
    () =>
      client.chat.send({
        chatRequest: {
          model: config.openrouterModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: createExtractionPrompt(config) },
                {
                  type: "file",
                  file: {
                    filename: "utility-bill-first-page.pdf",
                    fileData: `data:application/pdf;base64,${b64}`,
                  },
                },
              ],
            },
          ],
          provider: {
            requireParameters: true,
          },
          responseFormat: {
            type: "json_schema",
            jsonSchema: {
              name: "utility_bill",
              strict: true,
              schema: jsonSchema,
            },
          },
        },
      }),
    { label: "openrouter-ocr" },
  );

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("OpenRouter returned an empty response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenRouter response is not valid JSON: ${raw}`);
  }

  const validation = ocrResponseSchema.safeParse(parsed);
  if (!validation.success) {
    throw new Error(
      `Unexpected OCR response shape: ${z.prettifyError(validation.error)}`,
    );
  }
  const billData = validation.data;

  ocrLogger.info(
    {
      billDate: billData.bill_date,
      dueDate: billData.due_date,
      totalAmountDollars: billData.total_amount,
      categoryCount: billData.categories.length,
    },
    "OpenRouter OCR response parsed",
  );

  return {
    billDate: billData.bill_date,
    dueDate: billData.due_date,
    totalAmountDollars: dollars(billData.total_amount),
    categories: billData.categories.map((cat) => ({
      name: cat.name,
      amountDollars: dollars(cat.amount),
    })),
  };
}
