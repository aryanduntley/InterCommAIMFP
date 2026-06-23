// Task contract serialize/parse (Phase 2: directive-driven tasking).
//
// A master serializes a TaskContract into a message's content with
// buildTaskContract; a worker recovers it with parseTaskContract. InterComm
// itself stays AIMFP-agnostic — it never reads requiredDirectives or runs
// validation; it only carries this string as opaque message content. Pure
// functions only, no IO.

import type { TaskContract, ParsedTaskContract } from "./types.js";

// Discriminator + version embedded in the serialized JSON so parseTaskContract
// can distinguish a task contract from arbitrary message content and reject
// incompatible future shapes.
const CONTRACT_KIND = "task_contract";
const CONTRACT_VERSION = 1;

// Required string-array fields, validated uniformly on parse.
const STRING_ARRAY_FIELDS = [
  "constraints",
  "validation",
  "requiredDirectives",
  "reportBack",
] as const;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

// Master-side: serialize a contract into messages.content.
export const buildTaskContract = (contract: TaskContract): string =>
  JSON.stringify({
    kind: CONTRACT_KIND,
    v: CONTRACT_VERSION,
    goal: contract.goal,
    constraints: contract.constraints,
    validation: contract.validation,
    output: contract.output,
    branchConvention: contract.branchConvention,
    requiredDirectives: contract.requiredDirectives,
    reportBack: contract.reportBack,
  });

// Worker-side: parse + validate a content string into a TaskContract. Never
// throws — returns {ok:false, error} for any non-contract or malformed input.
export const parseTaskContract = (content: string): ParsedTaskContract => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, error: "content is not valid JSON" };
  }

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "content is not a task contract object" };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.kind !== CONTRACT_KIND) {
    return { ok: false, error: "content is not a task contract" };
  }
  if (obj.v !== CONTRACT_VERSION) {
    return {
      ok: false,
      error: `unsupported task contract version: ${String(obj.v)}`,
    };
  }

  if (!isNonEmptyString(obj.goal)) {
    return { ok: false, error: "goal must be a non-empty string" };
  }
  if (!isNonEmptyString(obj.output)) {
    return { ok: false, error: "output must be a non-empty string" };
  }
  if (!isNonEmptyString(obj.branchConvention)) {
    return { ok: false, error: "branchConvention must be a non-empty string" };
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!isStringArray(obj[field])) {
      return { ok: false, error: `${field} must be an array of strings` };
    }
  }

  return {
    ok: true,
    contract: {
      goal: obj.goal,
      constraints: obj.constraints as string[],
      validation: obj.validation as string[],
      output: obj.output,
      branchConvention: obj.branchConvention,
      requiredDirectives: obj.requiredDirectives as string[],
      reportBack: obj.reportBack as string[],
    },
  };
};
