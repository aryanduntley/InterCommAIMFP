/** Result type for operations that can fail */
export type Result =
  | { ok: true; value: number }
  | { ok: false; error: string };

/** Create a success result */
const ok = (value: number): Result => ({ ok: true, value });

/** Create an error result */
const err = (error: string): Result => ({ ok: false, error });

/**
 * Add two numbers.
 * @param a - First operand
 * @param b - Second operand
 * @returns The sum of a and b
 */
export const add = (a: number, b: number): number => a + b;

/**
 * Subtract two numbers.
 * @param a - First operand
 * @param b - Second operand
 * @returns The difference of a and b
 */
export const subtract = (a: number, b: number): number => a - b;

/**
 * Multiply two numbers.
 * @param a - First operand
 * @param b - Second operand
 * @returns The product of a and b
 */
export const multiply = (a: number, b: number): number => a * b;

/**
 * Divide two numbers.
 * @param a - Dividend
 * @param b - Divisor
 * @returns A Result with the quotient, or an error if b is zero
 */
export const divide = (a: number, b: number): Result =>
  b === 0 ? err("Division by zero") : ok(a / b);

/**
 * Raise a base to an exponent.
 * @param base - The base number
 * @param exponent - The exponent
 * @returns The result of base^exponent
 */
export const power = (base: number, exponent: number): number =>
  Math.pow(base, exponent);

/**
 * Compute the square root of a number.
 * @param n - The number to take the square root of
 * @returns A Result with the square root, or an error if n is negative
 */
export const squareRoot = (n: number): Result =>
  n < 0 ? err("Cannot take square root of a negative number") : ok(Math.sqrt(n));

/**
 * Compute the modulo (remainder) of two numbers.
 * @param a - Dividend
 * @param b - Divisor
 * @returns A Result with the remainder, or an error if b is zero
 */
export const modulo = (a: number, b: number): Result =>
  b === 0 ? err("Modulo by zero") : ok(a % b);
