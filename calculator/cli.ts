import { add, subtract, multiply, divide, power, squareRoot, modulo } from "./operations";

type OpResult = { ok: true; value: number } | { ok: false; error: string };

const OPERATORS: Record<string, (a: number, b: number) => OpResult> = {
  "+": add,
  "-": subtract,
  "*": multiply,
  "/": divide,
  "^": power,
  "%": modulo,
};

const parseNumber = (raw: string): { ok: true; value: number } | { ok: false; error: string } => {
  const n = Number(raw);
  return Number.isNaN(n)
    ? { ok: false, error: `"${raw}" is not a valid number` }
    : { ok: true, value: n };
};

const run = (args: string[]): string => {
  if (args.length === 0) {
    return "Usage: node cli.js <number> <operator> <number>  or  node cli.js sqrt <number>";
  }

  // Unary: sqrt <number>
  if (args[0] === "sqrt") {
    if (args.length !== 2) return "Usage: node cli.js sqrt <number>";
    const parsed = parseNumber(args[1]);
    if (!parsed.ok) return `Error: ${parsed.error}`;
    const result = squareRoot(parsed.value);
    return result.ok ? String(result.value) : `Error: ${result.error}`;
  }

  // Binary: <number> <operator> <number>
  if (args.length !== 3) {
    return "Usage: node cli.js <number> <operator> <number>";
  }

  const [rawLeft, operator, rawRight] = args;

  const left = parseNumber(rawLeft);
  if (!left.ok) return `Error: ${left.error}`;

  const right = parseNumber(rawRight);
  if (!right.ok) return `Error: ${right.error}`;

  const opFn = OPERATORS[operator];
  if (!opFn) return `Error: unknown operator "${operator}". Supported: + - * / ^ %`;

  const result = opFn(left.value, right.value);
  return result.ok ? String(result.value) : `Error: ${result.error}`;
};

const output = run(process.argv.slice(2));
console.log(output);
