import { Temporal } from "@js-temporal/polyfill";
import * as ynab from "ynab";
import type { Config } from "./config";
import { logger as rootLogger } from "./logger";
import type { BillData } from "./ocr";
import {
  dollarsToMilliunitsOutflow,
  type Dollars,
  type Milliunits,
} from "./units";

export class YNABClient {
  private readonly api: ynab.API;
  private readonly budgetId: string;
  private readonly accountId: string;
  private readonly logger = rootLogger.child({ module: "ynab" });

  constructor(config: Config) {
    this.api = new ynab.API(config.ynabApiKey);
    this.budgetId = config.ynabBudgetId;
    this.accountId = config.ynabAccountId;
  }

  async findScheduledTransaction(
    memoTag: string
  ): Promise<ynab.ScheduledTransactionDetail | null> {
    this.logger.info({ memoTag }, "Searching scheduled transactions");
    const response = await this.api.scheduledTransactions.getScheduledTransactions(
      this.budgetId
    );
    const transaction =
      response.data.scheduled_transactions.find((tx) =>
        tx.memo?.includes(memoTag)
      ) ?? null;
    this.logger.info(
      {
        memoTag,
        found: transaction != null,
        scheduledTransactionId: transaction?.id,
      },
      "Scheduled transaction search complete"
    );
    return transaction;
  }

  async findRegularTransaction(
    memoTag: string,
    dueDateStr: string
  ): Promise<ynab.TransactionDetail | null> {
    const windowStartStr = addDays(dueDateStr, -7);
    const windowEndStr = addDays(dueDateStr, 7);
    this.logger.info(
      { memoTag, windowStartStr, windowEndStr },
      "Searching regular transactions"
    );
    const response = await this.api.transactions.getTransactions(
      this.budgetId,
      windowStartStr
    );
    const transaction =
      response.data.transactions.find(
        (tx) =>
          tx.memo?.includes(memoTag) &&
          tx.date <= windowEndStr
      ) ?? null;
    this.logger.info(
      {
        memoTag,
        windowStartStr,
        windowEndStr,
        found: transaction != null,
        transactionId: transaction?.id,
      },
      "Regular transaction search complete"
    );
    return transaction;
  }

  async createScheduledTransaction(
    dueDateStr: string,
    totalAmountDollars: Dollars,
    memo: string
  ): Promise<void> {
    const totalAmountMilliunits = dollarsToMilliunitsOutflow(totalAmountDollars);
    this.logger.info(
      { dueDateStr, totalAmountDollars, totalAmountMilliunits, memo },
      "Creating scheduled transaction"
    );
    await this.api.scheduledTransactions.createScheduledTransaction(
      this.budgetId,
      {
        scheduled_transaction: {
          account_id: this.accountId,
          date: dueDateStr,
          amount: totalAmountMilliunits,
          memo,
          frequency: ynab.ScheduledTransactionFrequency.Never,
        },
      }
    );
    this.logger.info({ dueDateStr, memo }, "Scheduled transaction created");
  }

  async splitTransaction(
    transactionId: string,
    bill: BillData,
    config: Config
  ): Promise<void> {
    const totalAmountMilliunits = dollarsToMilliunitsOutflow(
      bill.totalAmountDollars
    );
    const subtransactions = buildSubtransactions(
      bill,
      config,
      totalAmountMilliunits
    );
    this.logger.info(
      {
        transactionId,
        billDate: bill.billDate,
        totalAmountMilliunits,
        subtransactionCount: subtransactions.length,
      },
      "Splitting transaction"
    );
    await this.api.transactions.updateTransaction(this.budgetId, transactionId, {
      transaction: {
        subtransactions,
      },
    });
    this.logger.info({ transactionId }, "Transaction split complete");
  }

  isAlreadySplit(tx: ynab.TransactionDetail): boolean {
    return tx.subtransactions != null && tx.subtransactions.length > 0;
  }
}

function addDays(dateStr: string, days: number): string {
  return Temporal.PlainDate.from(dateStr).add({ days }).toString();
}

function buildSubtransactions(
  bill: BillData,
  config: Config,
  totalAmountMilliunits: Milliunits
): ynab.SaveSubTransaction[] {
  const myHalves: ynab.SaveSubTransaction[] = bill.categories.map((category) => ({
    amount: dollarsToMilliunitsOutflow((category.amountDollars / 2) as Dollars),
    category_id: config.categoryMappings[category.name.toLowerCase()] ?? null,
  }));

  const myHalfSum = myHalves.reduce((sum, s) => sum + s.amount, 0) as Milliunits;

  return [
    ...myHalves,
    {
      amount: (totalAmountMilliunits - myHalfSum) as Milliunits,
      category_id: config.ynabReimbursementsCategoryId,
    },
  ];
}
