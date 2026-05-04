import * as ynab from "ynab";
import type { Config } from "./config";
import { logger as rootLogger } from "./logger";
import type { BillData } from "./ocr";
import {
  dollarsToMilliunitsOutflow,
  milliunits,
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
    sinceDateStr: string
  ): Promise<ynab.TransactionDetail | null> {
    this.logger.info({ memoTag, sinceDateStr }, "Searching regular transactions");
    const response = await this.api.transactions.getTransactions(
      this.budgetId,
      sinceDateStr
    );
    const transaction =
      response.data.transactions.find((tx) => tx.memo?.includes(memoTag)) ??
      null;
    this.logger.info(
      {
        memoTag,
        sinceDateStr,
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

function buildSubtransactions(
  bill: BillData,
  config: Config,
  totalAmountMilliunits: Milliunits
): ynab.SaveSubTransaction[] {
  const subtransactions: ynab.SaveSubTransaction[] = [];

  for (const category of bill.categories) {
    const halfAmountDollars = (category.amountDollars / 2) as Dollars;
    const halfAmountMilliunits = dollarsToMilliunitsOutflow(halfAmountDollars);
    const categoryId =
      config.categoryMappings[category.name.toLowerCase()];

    subtransactions.push(
      {
        amount: halfAmountMilliunits,
        category_id: categoryId ?? null,
        memo: `My half — ${category.name}`,
      },
      {
        amount: halfAmountMilliunits,
        category_id: config.ynabReimbursementsCategoryId,
        memo: `Roommate half — ${category.name}`,
      }
    );
  }

  // Adjust the last subtransaction to absorb any rounding drift so all
  // subtransaction amounts sum exactly to the parent transaction amount.
  const subtransactionSum = subtransactions.reduce(
    (sum, s) => sum + s.amount,
    0
  ) as Milliunits;
  const drift = (totalAmountMilliunits - subtransactionSum) as Milliunits;
  if (drift !== milliunits(0)) {
    const last = subtransactions[subtransactions.length - 1];
    last.amount = (last.amount + drift) as Milliunits;
  }

  return subtransactions;
}
