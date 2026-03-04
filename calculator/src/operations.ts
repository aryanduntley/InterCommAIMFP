export type MathResult = { result: number } | { error: string };

export const add = (a: number, b: number): number => a + b;

export const subtract = (a: number, b: number): number => a - b;

export const multiply = (a: number, b: number): number => a * b;

export const divide = (a: number, b: number): MathResult =>
  b === 0 ? { error: "Division by zero" } : { result: a / b };

const tokenize = (expression: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < expression.length) {
    if (expression[i] === " ") {
      i++;
      continue;
    }
    if ("+-*/".includes(expression[i]) && tokens.length > 0) {
      tokens.push(expression[i]);
      i++;
      continue;
    }
    // Parse number (possibly negative at start or after operator)
    let num = "";
    if (expression[i] === "-" && (tokens.length === 0 || "+-*/".includes(tokens[tokens.length - 1]))) {
      num = "-";
      i++;
    }
    while (i < expression.length && (expression[i] >= "0" && expression[i] <= "9" || expression[i] === ".")) {
      num += expression[i];
      i++;
    }
    if (num === "" || num === "-") return ["ERR"];
    tokens.push(num);
  }
  return tokens;
};

const applyOp = (op: string, a: number, b: number): MathResult => {
  switch (op) {
    case "+": return { result: add(a, b) };
    case "-": return { result: subtract(a, b) };
    case "*": return { result: multiply(a, b) };
    case "/": return divide(a, b);
    default: return { error: `Unknown operator: ${op}` };
  }
};

export const evaluate = (expression: string): MathResult => {
  const tokens = tokenize(expression.trim());
  if (tokens.length === 0 || tokens[0] === "ERR") return { error: "Invalid expression" };

  // Parse into numbers and operators
  const numbers: number[] = [];
  const ops: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (i % 2 === 0) {
      const n = parseFloat(tokens[i]);
      if (isNaN(n)) return { error: "Invalid expression" };
      numbers.push(n);
    } else {
      if (!"+-*/".includes(tokens[i])) return { error: "Invalid expression" };
      ops.push(tokens[i]);
    }
  }

  if (numbers.length !== ops.length + 1) return { error: "Invalid expression" };

  // First pass: handle * and / (higher precedence)
  const reducedNums: number[] = [numbers[0]];
  const reducedOps: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === "*" || ops[i] === "/") {
      const res = applyOp(ops[i], reducedNums[reducedNums.length - 1], numbers[i + 1]);
      if ("error" in res) return res;
      reducedNums[reducedNums.length - 1] = res.result;
    } else {
      reducedOps.push(ops[i]);
      reducedNums.push(numbers[i + 1]);
    }
  }

  // Second pass: handle + and -
  let acc = reducedNums[0];
  for (let i = 0; i < reducedOps.length; i++) {
    const res = applyOp(reducedOps[i], acc, reducedNums[i + 1]);
    if ("error" in res) return res;
    acc = res.result;
  }

  return { result: acc };
};
