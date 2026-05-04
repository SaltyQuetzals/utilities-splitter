declare const DollarsBrand: unique symbol;
declare const MilliunitsBrand: unique symbol;

export type Dollars = number & { readonly [DollarsBrand]: true };
export type Milliunits = number & { readonly [MilliunitsBrand]: true };

export function dollars(amount: number): Dollars {
  return amount as Dollars;
}

export function milliunits(amount: number): Milliunits {
  return amount as Milliunits;
}

/** YNAB convention: outflow is represented as negative milliunits. */
export function dollarsToMilliunitsOutflow(amountDollars: Dollars): Milliunits {
  return Math.round(amountDollars * -1000) as Milliunits;
}

export function milliunitsToAbsDollars(amountMilliunits: Milliunits): Dollars {
  return (Math.abs(amountMilliunits) / 1000) as Dollars;
}
