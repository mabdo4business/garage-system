import { ValidationError } from "../core/errors";
import { divRoundHalfUp, Money, Qty } from "../core/money";

/**
 * Estimate line arithmetic (AC-06.1). Prices include VAT (OD-14); VAT is taken out per line (OD-18):
 *
 *   gross = qty × unit price                 rounded half-up to the fil
 *   total = gross − discount                 the amount quoted to the customer
 *   net   = total × 100 / (100 + rate)       rounded half-up to the fil
 *   vat   = total − net
 *
 * Document totals are sums of the rounded lines. The rounding method is an assumption for the tax
 * agent (V-2). Migration 0011 checks the same identities on every row.
 */

export interface LineAmounts {
  gross: Money;
  discount: Money;
  total: Money;
  net: Money;
  vat: Money;
}

/** Largest amount numeric(14,2) holds. */
const MAX_AMOUNT = Money.parse("999999999999.99");
/** Largest quantity we accept on a line; numeric(18,3) holds far more, but no repair needs it. */
const MAX_QTY = Qty.parse("100000");

/** A tax rate such as "5.00" in hundredths of a percent (500n). */
export function rateHundredths(rate: string): bigint {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(rate);
  if (!match) throw new RangeError(`Invalid tax rate ${rate}`);
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

export function computeLine(input: {
  qty: Qty;
  unitPrice: Money;
  discount: Money;
  rate: string;
}): LineAmounts {
  const gross = Money.fromFils(divRoundHalfUp(input.qty.milli * input.unitPrice.fils, 1000n));
  if (gross.compare(MAX_AMOUNT) > 0) {
    throw new ValidationError("The line amount is too large", { field: "qty" });
  }
  if (input.discount.isNegative() || input.discount.compare(gross) > 0) {
    throw new ValidationError("The discount must be between 0 and the line amount", { field: "discount" });
  }
  const total = gross.sub(input.discount);
  const net = Money.fromFils(divRoundHalfUp(total.fils * 10000n, 10000n + rateHundredths(input.rate)));
  return { gross, discount: input.discount, total, net, vat: total.sub(net) };
}

export interface EstimateTotals {
  /** Σ gross, VAT-inclusive, before discounts. */
  gross: Money;
  discount: Money;
  /** Σ line totals: what the customer pays. */
  total: Money;
  net: Money;
  vat: Money;
  /** VAT per rate, for the "VAT (rate and amount)" footer (AC-06.1). */
  byRate: { rate: string; net: Money; vat: Money }[];
}

export function sumLines(lines: readonly (LineAmounts & { rate: string })[]): EstimateTotals {
  const byRate = new Map<string, { rate: string; net: Money; vat: Money }>();
  let gross = Money.ZERO;
  let discount = Money.ZERO;
  let total = Money.ZERO;
  let net = Money.ZERO;
  let vat = Money.ZERO;
  for (const line of lines) {
    gross = gross.add(line.gross);
    discount = discount.add(line.discount);
    total = total.add(line.total);
    net = net.add(line.net);
    vat = vat.add(line.vat);
    const bucket = byRate.get(line.rate) ?? { rate: line.rate, net: Money.ZERO, vat: Money.ZERO };
    byRate.set(line.rate, { rate: line.rate, net: bucket.net.add(line.net), vat: bucket.vat.add(line.vat) });
  }
  const rates = [...byRate.values()].sort((a, b) => {
    const x = rateHundredths(a.rate);
    const y = rateHundredths(b.rate);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { gross, discount, total, net, vat, byRate: rates };
}

/** A positive quantity with at most 3 decimals (hours for labor, T-18). */
export function parseQty(value: unknown): Qty {
  try {
    const qty = Qty.parse(typeof value === "string" ? value.trim() : value);
    if (!qty.isPositive() || qty.compare(MAX_QTY) > 0) throw new Error("out of range");
    return qty;
  } catch {
    throw new ValidationError("Enter a quantity like 1 or 1.5", { field: "qty" });
  }
}

/** A non-negative discount with at most 2 decimals. */
export function parseDiscount(value: unknown): Money {
  try {
    const raw = typeof value === "string" ? value.trim() : value;
    const amount = Money.parse(raw === "" ? "0" : raw);
    if (amount.isNegative() || amount.compare(MAX_AMOUNT) > 0) throw new Error("out of range");
    return amount;
  } catch {
    throw new ValidationError("Enter a discount like 20 or 20.50", { field: "discount" });
  }
}
