// Task contract serialize/parse (Phase 2: directive-driven tasking).
//
// Thin-pointer model: a master serializes a TaskContract into a message's
// content with buildTaskContract; a worker recovers it with parseTaskContract.
// The contract is a POINTER to an AIMFP work entity, not a prose instruction —
// the worker runs aimfp_run in its own clone and continues that entity normally.
// InterComm stays AIMFP-agnostic: it never resolves aimfp_target and never reads
// project.db; it only carries this string as opaque message content. Pure
// functions only, no IO.

import type {
  TaskContract,
  ParsedTaskContract,
  AimfpTarget,
  AimfpTargetType,
} from "./types.js";

// Discriminator + version embedded in the serialized JSON so parseTaskContract
// can distinguish a task contract from arbitrary message content and reject the
// superseded prose shape (v1) and any incompatible future shapes.
const CONTRACT_KIND = "task_contract";
const CONTRACT_VERSION = 2;

// The AIMFP tables a pointer may reference (mirrors AimfpTargetType).
const AIMFP_TARGET_TYPES: readonly AimfpTargetType[] = [
  "task",
  "milestone",
  "subtask",
  "sidequest",
  "item",
];

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

// Validate the pointer: a known type plus at least one of id (number) | slug
// (non-empty string). Returns the typed target or an error reason.
const parseAimfpTarget = (
  value: unknown,
): { ok: true; target: AimfpTarget } | { ok: false; error: string } => {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "aimfp_target must be an object" };
  }
  const obj = value as Record<string, unknown>;

  if (!AIMFP_TARGET_TYPES.includes(obj.type as AimfpTargetType)) {
    return {
      ok: false,
      error: `aimfp_target.type must be one of ${AIMFP_TARGET_TYPES.join(", ")}`,
    };
  }

  const hasId = typeof obj.id === "number" && Number.isInteger(obj.id);
  const hasSlug = isNonEmptyString(obj.slug);
  if (!hasId && !hasSlug) {
    return {
      ok: false,
      error: "aimfp_target must have an integer id or a non-empty slug",
    };
  }

  return {
    ok: true,
    target: {
      type: obj.type as AimfpTargetType,
      ...(hasId ? { id: obj.id as number } : {}),
      ...(hasSlug ? { slug: obj.slug as string } : {}),
    },
  };
};

// Master-side: serialize a thin-pointer contract into messages.content.
export const buildTaskContract = (contract: TaskContract): string =>
  JSON.stringify({
    kind: CONTRACT_KIND,
    v: CONTRACT_VERSION,
    role: contract.role,
    role_instructions: contract.role_instructions,
    aimfp_target: contract.aimfp_target,
    reportBack: contract.reportBack,
  });

// Worker-side: parse + validate a content string into a TaskContract. Never
// throws — returns {ok:false, error} for any non-contract, malformed, or
// superseded (v1) input.
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

  if (!isNonEmptyString(obj.role)) {
    return { ok: false, error: "role must be a non-empty string" };
  }
  if (!isNonEmptyString(obj.role_instructions)) {
    return { ok: false, error: "role_instructions must be a non-empty string" };
  }
  if (!isStringArray(obj.reportBack)) {
    return { ok: false, error: "reportBack must be an array of strings" };
  }

  const target = parseAimfpTarget(obj.aimfp_target);
  if (!target.ok) {
    return { ok: false, error: target.error };
  }

  return {
    ok: true,
    contract: {
      role: obj.role,
      role_instructions: obj.role_instructions,
      aimfp_target: target.target,
      reportBack: obj.reportBack,
    },
  };
};
