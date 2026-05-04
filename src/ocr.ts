import OpenAI from "openai";
import type { Config } from "./config";
import { dollars, type Dollars } from "./units";

export interface BillCategory {
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

interface OcrResponse {
  bill_date: string;
  due_date: string;
  total_amount: number;
  categories: Array<{ name: string; amount: number }>;
}

const EXTRACTION_PROMPT = `You are extracting structured data from a utility bill image.

Return a JSON object with exactly these fields:
- bill_date: the bill issue date in YYYY-MM-DD format
- due_date: the payment due date in YYYY-MM-DD format
- total_amount: the total amount due as a number (dollars, no currency symbol)
- categories: an array of objects, each with:
  - name: the category/service name (e.g. "Electric", "Gas", "Water")
  - amount: the charge amount as a number (dollars, no currency symbol)

Return only valid JSON. Do not include any explanation or markdown.`;

function isOcrResponse(value: unknown): value is OcrResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.bill_date !== "string") return false;
  if (typeof v.due_date !== "string") return false;
  if (typeof v.total_amount !== "number") return false;
  if (!Array.isArray(v.categories)) return false;
  for (const cat of v.categories) {
    if (typeof cat !== "object" || cat === null) return false;
    if (typeof (cat as Record<string, unknown>).name !== "string") return false;
    if (typeof (cat as Record<string, unknown>).amount !== "number") return false;
  }
  return true;
}

export async function extractBillData(
  screenshotBuffer: Buffer,
  config: Config
): Promise<BillData> {
  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.openrouterApiKey,
  });

  const b64 = screenshotBuffer.toString("base64");

  const response = await client.chat.completions.create({
    model: config.openrouterModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXTRACTION_PROMPT },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${b64}` },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("OpenRouter returned an empty response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenRouter response is not valid JSON: ${raw}`);
  }

  if (!isOcrResponse(parsed)) {
    throw new Error(`Unexpected OCR response shape: ${JSON.stringify(parsed)}`);
  }

  return {
    billDate: parsed.bill_date,
    dueDate: parsed.due_date,
    totalAmountDollars: dollars(parsed.total_amount),
    categories: parsed.categories.map((cat) => ({
      name: cat.name,
      amountDollars: dollars(cat.amount),
    })),
  };
}
