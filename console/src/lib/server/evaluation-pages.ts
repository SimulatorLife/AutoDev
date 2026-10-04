import type {
  ControlApiEvaluationResultResponse,
  EvaluationResultsFilter
} from "@simulatorlife/autodev-core";

import {
  type ControlApiConfig,
  controlApiFailureCode,
  fetchEvaluationResult
} from "./control-api.ts";
import {
  EVALUATION_NOTICES,
  isEvaluationNotice
} from "./evaluation-actions.ts";

export type EvaluationSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

const MAX_PARAM_LENGTH = 256;
const NOTICE_CODE_PATTERN = /^[a-z0-9_]{1,96}$/u;

export function firstParam(
  params: EvaluationSearchParams,
  key: string
): string | null {
  const raw = params[key];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  return value && value.length <= MAX_PARAM_LENGTH ? value : null;
}

/** URL-addressable result filters; the Control API validates their shape. */
export function evaluationFilterFromSearchParams(
  params: EvaluationSearchParams
): EvaluationResultsFilter {
  const filter: {
    definition?: string;
    run?: string;
    agent?: string;
    model?: string;
    prompt?: string;
  } = {};
  for (const key of [
    "definition",
    "run",
    "agent",
    "model",
    "prompt"
  ] as const) {
    const value = firstParam(params, key);
    if (value) filter[key] = value;
  }
  return filter;
}

export function evaluationNoticeFromSearchParams(
  params: EvaluationSearchParams
): { readonly notice: string | null; readonly code: string | null } {
  const notice = firstParam(params, "notice");
  if (!isEvaluationNotice(notice)) return { notice: null, code: null };
  const code = firstParam(params, "code");
  return {
    notice: EVALUATION_NOTICES[notice],
    code: code && NOTICE_CODE_PATTERN.test(code) ? code : null
  };
}

export interface EvaluationResultSelection {
  readonly selectedResult: ControlApiEvaluationResultResponse | null;
  readonly resultError: {
    readonly code: string;
    readonly message: string;
  } | null;
}

/** Loads the `?result=` panel; a failure is reported beside the page, not over it. */
export async function loadEvaluationResultSelection(
  params: EvaluationSearchParams,
  config: ControlApiConfig
): Promise<EvaluationResultSelection> {
  const resultId = firstParam(params, "result");
  if (!resultId) return { selectedResult: null, resultError: null };
  const result = await fetchEvaluationResult(resultId, config);
  return result.kind === "ok"
    ? { selectedResult: result.data, resultError: null }
    : {
        selectedResult: null,
        resultError: {
          code: controlApiFailureCode(result),
          message: result.message
        }
      };
}
