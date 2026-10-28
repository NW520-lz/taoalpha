import { Decimal as BaseDecimal } from "decimal.js";

// decimal.js defaults to 20 significant digits, which silently rounds
// price × size × contract-value products. 50 digits keeps them exact.
export const Decimal = BaseDecimal.clone({ precision: 50, rounding: BaseDecimal.ROUND_HALF_EVEN });
export type Decimal = InstanceType<typeof Decimal>;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_PATTERN.test(value);
}

/** Parse a plain decimal string (OKX format). Empty strings and exponent forms are rejected. */
export function dec(value: string): Decimal {
  if (!isDecimalString(value)) throw new Error(`not a decimal string: ${JSON.stringify(value)}`);
  return new Decimal(value);
}
