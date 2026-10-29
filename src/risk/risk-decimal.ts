import { Decimal as BaseDecimal } from "decimal.js";
import { isDecimalString as isPlainDecimalString } from "../lib/decimal.ts";

// Inputs are bounded to 256 characters. Finite products and sums in risk
// calculations fit within 2048 significant digits, including aggregation.
// The only non-terminating division estimates required margin: round upward.
export const Decimal = BaseDecimal.clone({ precision: 2048, rounding: BaseDecimal.ROUND_CEIL });
export type Decimal = InstanceType<typeof Decimal>;

export function isDecimalString(value: string): boolean {
  return value.length <= 256 && isPlainDecimalString(value);
}

// Derived values can be longer than input, especially conservative division.
export function dec(value: string): Decimal {
  return new Decimal(value);
}
