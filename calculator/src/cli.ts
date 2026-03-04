import * as readline from "node:readline";
import { evaluate } from "./operations";

const WELCOME = "Simple Calculator — type an expression or 'quit' to exit";
const PROMPT = "> ";

const handleInput = (line: string): { output: string; quit: boolean } => {
  const trimmed = line.trim();
  if (trimmed === "quit" || trimmed === "exit") {
    return { output: "Goodbye!", quit: true };
  }
  if (trimmed === "") {
    return { output: "", quit: false };
  }
  const result = evaluate(trimmed);
  if ("error" in result) {
    return { output: `Error: ${result.error}`, quit: false };
  }
  return { output: String(result.result), quit: false };
};

const main = (): void => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(WELCOME);

  const promptUser = (): void => {
    rl.question(PROMPT, (line) => {
      const { output, quit } = handleInput(line);
      if (output) console.log(output);
      if (quit) {
        rl.close();
        return;
      }
      promptUser();
    });
  };

  promptUser();
};

main();
