import "dotenv/config";
import * as ynab from "ynab";

interface CliOptions {
  budgetId?: string;
  includeClosed: boolean;
  includeHidden: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    includeClosed: false,
    includeHidden: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--budget" || arg === "-b") {
      const budgetId = args[i + 1];
      if (!budgetId) throw new Error("Missing value for --budget");
      options.budgetId = budgetId;
      i++;
      continue;
    }

    if (arg === "--include-closed") {
      options.includeClosed = true;
      continue;
    }

    if (arg === "--include-hidden") {
      options.includeHidden = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: bun run ynab:ids [options]

Lists the YNAB budget, account, and category IDs available to YNAB_API_KEY.

Options:
  -b, --budget <id>   Only list accounts and categories for one budget
  --include-closed    Include closed accounts
  --include-hidden    Include hidden category groups and categories
  -h, --help          Show this help
`);
}

function formatStatus(flags: string[]): string {
  return flags.length > 0 ? flags.join(", ") : "-";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const api = new ynab.API(requireEnv("YNAB_API_KEY"));

  const plansResponse = await api.plans.getPlans();
  const budgets = plansResponse.data.plans;

  console.log("Budgets");
  console.table(
    budgets.map((budget) => ({
      name: budget.name,
      id: budget.id,
      lastModified: budget.last_modified_on ?? "-",
    })),
  );

  const selectedBudgets = options.budgetId
    ? budgets.filter((budget) => budget.id === options.budgetId)
    : budgets;

  if (options.budgetId && selectedBudgets.length === 0) {
    throw new Error(`No budget found with id: ${options.budgetId}`);
  }

  for (const budget of selectedBudgets) {
    console.log(`\nBudget: ${budget.name}`);
    console.log(`Budget ID: ${budget.id}`);

    const accountsResponse = await api.accounts.getAccounts(budget.id);
    const accounts = accountsResponse.data.accounts.filter(
      (account) => options.includeClosed || !account.closed,
    );

    console.log("\nAccounts");
    console.table(
      accounts.map((account) => ({
        name: account.name,
        id: account.id,
        type: account.type,
        onBudget: account.on_budget,
        status: formatStatus(
          [
            account.closed ? "closed" : "",
            account.deleted ? "deleted" : "",
          ].filter(Boolean),
        ),
      })),
    );

    const categoriesResponse = await api.categories.getCategories(budget.id);
    const categoryRows = categoriesResponse.data.category_groups
      .filter(
        (group) => options.includeHidden || (!group.hidden && !group.deleted),
      )
      .flatMap((group) =>
        group.categories
          .filter(
            (category) =>
              options.includeHidden || (!category.hidden && !category.deleted),
          )
          .map((category) => ({
            group: group.name,
            name: category.name,
            id: category.id,
            status: formatStatus(
              [
                group.hidden ? "hidden group" : "",
                group.deleted ? "deleted group" : "",
                category.hidden ? "hidden" : "",
                category.deleted ? "deleted" : "",
              ].filter(Boolean),
            ),
          })),
      );

    console.log("\nCategories");
    console.table(categoryRows);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`YNAB ID lookup failed: ${message}`);
  process.exit(1);
});
