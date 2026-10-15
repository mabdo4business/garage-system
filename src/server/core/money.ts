/**
 * Exact decimal types. JavaScript numbers are never used for money, cost or quantity.
 *
 *  Money: AED with 2 decimals, stored as integer fils (bigint).
 *  Qty:   quantity with 3 decimals, stored as integer thousandths (bigint).
 *         [A] 3 decimals is an assumption (e.g. litres of oil); confirm before stock work.
 *
 * Values enter the system only as decimal strings (or bigint minor units). Passing a
 * JavaScript number throws, so a float can never reach a calculation (Increment 0, S2).
 */

export class DecimalInputError extends Error {
  readonly code = "invalid_decimal";
}

function rejectNumbers(input: unknown, what: string): asserts input is string {
  if (typeof input === "number") {
    throw new DecimalInputError(`${what} must be a decimal string, not a JavaScript number`);
  }
  if (typeof input !== "string") {
    throw new DecimalInputError(`${what} must be a decimal string`);
  }
}

function parseScaled(input: string, scale: number, what: string): bigint {
  const match = /^(-)?(\d{1,15})(?:\.(\d+))?$/.exec(input.trim());
  if (!match) {
    throw new DecimalInputError(`${what} "${input}" is not a valid decimal`);
  }
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > scale) {
    throw new DecimalInputError(`${what} "${input}" has more than ${scale} decimal places`);
  }
  const units = BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
  return sign ? -units : units;
}

function formatScaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const factor = 10n ** BigInt(scale);
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Integer division rounded half away from zero ("half-up" for positive values).
 * The rounding method for tax is subject to tax-agent verification (V-2).
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("Division by zero");
  }
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (2n * n + d) / (2n * d);
  return negative ? -quotient : quotient;
}

export class Money {
  static readonly SCALE = 2;
  static readonly ZERO = new Money(0n);

  private constructor(readonly fils: bigint) {}

  static parse(input: unknown): Money {
    rejectNumbers(input, "Amount");
    return new Money(parseScaled(input, Money.SCALE, "Amount"));
  }

  static fromFils(fils: bigint): Money {
    return new Money(fils);
  }

  add(other: Money): Money {
    return new Money(this.fils + other.fils);
  }

  sub(other: Money): Money {
    return new Money(this.fils - other.fils);
  }

  isNegative(): boolean {
    return this.fils < 0n;
  }

  isZero(): boolean {
    return this.fils === 0n;
  }

  compare(other: Money): -1 | 0 | 1 {
    return this.fils < other.fils ? -1 : this.fils > other.fils ? 1 : 0;
  }

  min(other: Money): Money {
    return this.compare(other) <= 0 ? this : other;
  }

  equals(other: Money): boolean {
    return this.fils === other.fils;
  }

  /** Canonical string with exactly two decimals, e.g. "1234.50". */
  toString(): string {
    return formatScaled(this.fils, Money.SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}

export class Qty {
  static readonly SCALE = 3;
  static readonly ZERO = new Qty(0n);

  private constructor(readonly milli: bigint) {}

  static parse(input: unknown): Qty {
    rejectNumbers(input, "Quantity");
    return new Qty(parseScaled(input, Qty.SCALE, "Quantity"));
  }

  static fromMilli(milli: bigint): Qty {
    return new Qty(milli);
  }

  add(other: Qty): Qty {
    return new Qty(this.milli + other.milli);
  }

  sub(other: Qty): Qty {
    return new Qty(this.milli - other.milli);
  }

  isZero(): boolean {
    return this.milli === 0n;
  }

  isPositive(): boolean {
    return this.milli > 0n;
  }

  compare(other: Qty): -1 | 0 | 1 {
    return this.milli < other.milli ? -1 : this.milli > other.milli ? 1 : 0;
  }

  equals(other: Qty): boolean {
    return this.milli === other.milli;
  }

  toString(): string {
    return formatScaled(this.milli, Qty.SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Unit cost for display and storage at 6 decimals (Pre-Implementation Review P0-09). */
export function unitCost6(value: Money, qty: Qty): string {
  if (!qty.isPositive()) {
    throw new RangeError("Unit cost requires a positive quantity");
  }
  // value.fils / 10^2 ÷ qty.milli / 10^3, expressed in millionths (10^6).
  const micros = divRoundHalfUp(value.fils * 10n ** 7n, qty.milli);
  return formatScaled(micros, 6);
}
