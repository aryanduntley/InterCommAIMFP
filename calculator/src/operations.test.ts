import { add, subtract, multiply, divide, evaluate } from "./operations";

let passed = 0;
let failed = 0;

const assert = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name} — expected ${e}, got ${a}`);
    failed++;
  }
};

console.log("--- add ---");
assert("2 + 3", add(2, 3), 5);
assert("0 + 0", add(0, 0), 0);
assert("-1 + 1", add(-1, 1), 0);

console.log("--- subtract ---");
assert("5 - 3", subtract(5, 3), 2);
assert("0 - 7", subtract(0, 7), -7);

console.log("--- multiply ---");
assert("3 * 4", multiply(3, 4), 12);
assert("0 * 99", multiply(0, 99), 0);
assert("-2 * 3", multiply(-2, 3), -6);

console.log("--- divide ---");
assert("10 / 2", divide(10, 2), { result: 5 });
assert("7 / 2", divide(7, 2), { result: 3.5 });
assert("1 / 0", divide(1, 0), { error: "Division by zero" });

console.log("--- evaluate ---");
assert("2 + 3", evaluate("2 + 3"), { result: 5 });
assert("10 / 5", evaluate("10 / 5"), { result: 2 });
assert("4 * 3 - 1", evaluate("4 * 3 - 1"), { result: 11 });
assert("2 + 3 * 4", evaluate("2 + 3 * 4"), { result: 14 });
assert("10 - 2 * 3 + 1", evaluate("10 - 2 * 3 + 1"), { result: 5 });
assert("1 / 0", evaluate("1 / 0"), { error: "Division by zero" });
assert("empty string", evaluate(""), { error: "Invalid expression" });
assert("single number", evaluate("42"), { result: 42 });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
