/**
The Evaluations response contract, as one schema.

The Runtime produces this response, the Console reads it, and the Console's
startup preflight checks that the Runtime it is about to talk to speaks the
same contract. The Console used to hold its own hand-written guards and the
preflight a looser check of its own (schema id and an array, nothing about
the rows); one schema owned here is now the only statement of it.
*/
import { z } from "zod";

import { evaluationResultSchema } from "../evaluations/types.ts";

/**
The contract revision the Runtime and the Console must agree on.
*/
export const CONTROL_API_EVALUATIONS_SCHEMA_ID =
  "autodev-control-evaluations-v1" as const;

/**
The whole response.

`totalEvaluations` is every row the source holds, not `evaluations.length`:
the read is capped, so the array is the most recent N results while the total
is how many exist. `truncated` says whether the array is that bounded window,
and it is required rather than inferred, so no consumer has to compare the two
itself and risk rendering a capped window as the complete history.

The two size claims must agree with the rows they ship with, in both
directions, because the view renders each as a different fact. A total below
the row count is a total that cannot contain what it totals, and
`truncated: false` over a larger total is a capped window describing itself as
the whole history. The Runtime derives the flag with exactly this comparison
(`truncated: total > results.length`), so enforcing it cannot reject a
response this Runtime produced.
*/
export const controlApiEvaluationsResponseSchema = z
  .object({
    schema: z.literal(CONTROL_API_EVALUATIONS_SCHEMA_ID),
    source: z.string(),
    readOnly: z.boolean(),
    totalEvaluations: z.number().int().nonnegative(),
    truncated: z.boolean(),
    evaluations: z.array(evaluationResultSchema).readonly()
  })
  .readonly()
  .refine(
    (response) => {
      const isWindow = response.totalEvaluations > response.evaluations.length;
      return (
        response.totalEvaluations >= response.evaluations.length &&
        response.truncated === isWindow
      );
    },
    {
      message:
        "The response's total and truncation flag must agree with its rows."
    }
  );

export type ControlApiEvaluationsResponse = z.infer<
  typeof controlApiEvaluationsResponseSchema
>;
