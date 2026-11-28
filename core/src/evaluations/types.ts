/**
One evaluation result and its measurements, as one schema.

The Data layer builds these from the OpenLIT evaluation table, the Runtime
publishes them in the Evaluations response, and the Console reads them. The
types are read out of the schema, so the shape the Console validates against
is the shape the producer is type-checked against.
*/
import { z } from "zod";

/**
An identifier that says something: not empty, and not only whitespace. The
Data layer refuses a row whose id is blank, so a blank id is not one this
Runtime produced.
*/
const namedText = z.string().refine((value) => value.trim().length > 0, {
  message: "An identifier must say something."
});

/**
One measurement of one run.

`value` and `threshold` are finite numbers: Zod's number rejects `NaN` and
the infinities, and a float beyond the double range parses from JSON to
`Infinity` -- a number by every other test, and not a measurement. A quoted
number (`"12"`) is a string and is refused rather than read as a measurement.

`pass` is three states: `true`, `false`, or `null` when the source recorded no
verdict for the metric. A missing `pass` is not one of them.
*/
export const evaluationMetricSchema = z
  .object({
    name: z.string(),
    value: z.number(),
    threshold: z.number().optional(),
    pass: z.boolean().nullable()
  })
  .readonly();

/**
One evaluated run.

`passed` is required and three-state for the same reason as a metric's
`pass`: a missing verdict read as `undefined` is treated as a failure by every
verdict comparison downstream, so its absence would synthesize "did not pass"
out of unreadable evidence.

A run may name one metric only once. The Data layer builds metrics from the
keys of one scores object, so names are unique by construction, and a
response that repeats one is not a response this Runtime produced.
*/
export const evaluationResultSchema = z
  .object({
    id: namedText,
    spanId: z.string().optional(),
    agentRole: z.string(),
    promptName: z.string().optional(),
    model: z.string(),
    metrics: z
      .array(evaluationMetricSchema)
      .readonly()
      .refine(
        (metrics) =>
          new Set(metrics.map((metric) => metric.name)).size === metrics.length,
        { message: "A run may name one metric only once." }
      ),
    passed: z.boolean().nullable(),
    timestamp: z.string()
  })
  .readonly();

export type EvaluationMetric = z.infer<typeof evaluationMetricSchema>;
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
