/**
The canonical, operator-approved command catalogue.

A catalogue entry says *what* may run; it never says *who* may run it. The
role, workspace and session grants live in the canonical execution contract
and in the Runtime's own admission, and the effective surface is always the
intersection of the two.

Every entry is a fixed executable with a fixed argument vector. The only
model-supplied values are the narrowly typed parameters an entry declares,
and a parameter replaces a *whole* argument element -- it is never spliced
into the middle of one. Nothing declared here is ever handed to a shell.
*/
import { z } from "zod";

/**
A parameter's name, and the placeholder that refers to it in an argument.
*/
const parameterName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u);
/**
One argument element. A NUL byte is rejected outright: it truncates a C
string, so an argument carrying one would not reach the program the
catalogue describes.
*/
const argvElement = z.string().max(8192).refine((value) => !value.includes("\0"), {
  message: "An argument must not contain a NUL byte"
});
/**
A placeholder is a whole argument element naming exactly one parameter.
*/
const placeholderPattern = /^\{([a-z][a-z0-9_]{0,31})\}$/u;
/**
The execution classes the runtime knows how to confine.
*/
export const commandExecutionClasses = [
  "validation",
  "workspace_mutation",
  "dependency_install"
] as const;

export const commandParameterSchema = z.strictObject({
  description: z.string().trim().min(1).max(300),
  minLength: z.number().int().min(0).max(4096),
  maxLength: z.number().int().min(1).max(4096)
});

/** A bare executable name, never a path or a dot-directory. */
export const commandExecutableNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/u);

export const commandDefinitionSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(500),
    executable: commandExecutableNameSchema,
    args: z.array(argvElement).max(64),
    parameters: z.record(parameterName, commandParameterSchema).default({}),
    timeoutMs: z.number().int().positive().max(900_000),
    executionClass: z.enum(commandExecutionClasses),
    concurrency: z.literal("exclusive"),
    /**
    The canonical workspace ids (`owner/repository`) this command may run
    in. An entry without the key runs in every workspace its role holds the
    grant in; an entry with the key runs only in the workspaces it names.
    */
    workspaces: z.array(z.string().min(1).max(200)).max(64).optional()
  })
  .superRefine((definition, context) => {
    for (const [name, parameter] of Object.entries(definition.parameters)) {
      if (parameter.minLength > parameter.maxLength) {
        context.addIssue({
          code: "custom",
          path: ["parameters", name],
          message: "minLength must not exceed maxLength"
        });
      }
    }
    const declared = new Set(Object.keys(definition.parameters));
    if (declared.size > 16) {
      context.addIssue({
        code: "custom",
        path: ["parameters"],
        message: "A command may declare at most 16 parameters"
      });
    }
    const referenced = new Set<string>();
    for (const [index, element] of definition.args.entries()) {
      const placeholder = placeholderPattern.exec(element);
      if (!placeholder) continue;
      const name = placeholder[1]!;
      if (!declared.has(name)) {
        context.addIssue({
          code: "custom",
          path: ["args", index],
          message: `Argument refers to undeclared parameter "${name}"`
        });
        continue;
      }
      referenced.add(name);
    }
    for (const name of declared) {
      if (!referenced.has(name)) {
        context.addIssue({
          code: "custom",
          path: ["parameters", name],
          message: `Parameter "${name}" is never used by an argument`
        });
      }
    }
  });

export const commandCatalogueSchema = z.strictObject({
  version: z.literal(1),
  commands: z.record(parameterName, commandDefinitionSchema).refine(
    (commands) => Object.keys(commands).length <= 64,
    "A catalogue may declare at most 64 commands"
  )
});

export type CommandParameter = z.infer<typeof commandParameterSchema>;
export type CommandDefinition = z.infer<typeof commandDefinitionSchema>;
export type CommandCatalogue = z.infer<typeof commandCatalogueSchema>;

export function parseCommandCatalogue(input: unknown): CommandCatalogue {
  return commandCatalogueSchema.parse(input);
}

/**
The first object key that appears twice in one object of a JSON text, or
null when every object's keys are distinct.

`JSON.parse` keeps the last of two equal keys and drops the first without a
trace, so a catalogue reviewed by reading its text could grant a different
definition than the one the operator read. The text must already be valid
JSON; this only walks its strings and brackets.
*/
function duplicateJsonKey(text: string): string | null {
  const objects: Array<Set<string> | null> = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "{") objects.push(new Set());
    else if (character === "[") objects.push(null);
    else if (character === "}" || character === "]") objects.pop();
    else if (character === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const token = text.slice(index, end + 1);
      index = end + 1;
      while (/\s/u.test(text[index] ?? "")) index += 1;
      const keys = objects.at(-1);
      if (text[index] === ":" && keys) {
        const key = JSON.parse(token) as string;
        if (keys.has(key)) return key;
        keys.add(key);
      }
      continue;
    }
    index += 1;
  }
  return null;
}

/**
Parse a catalogue's text: valid JSON, no key declared twice in any object,
and a valid catalogue. This is the only reading of a catalogue file, for the
approved copy the backend serves and for the proposal offered for approval.
*/
export function parseCommandCatalogueText(text: string): CommandCatalogue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CommandCatalogueError("The command catalogue is not valid JSON.", "INVALID_CATALOGUE");
  }
  const duplicate = duplicateJsonKey(text);
  if (duplicate !== null) {
    throw new CommandCatalogueError(
      `The command catalogue declares "${duplicate.slice(0, 64)}" more than once in one object; ` +
        "only one declaration may be the reviewed one.",
      "DUPLICATE_CATALOGUE_KEY"
    );
  }
  return parseCommandCatalogue(parsed);
}

/**
A rejected catalogue or invocation.

The message is operator-facing and names the offending declaration; it never
echoes a value the caller supplied, because a rejected value may itself be
sensitive.
*/
export class CommandCatalogueError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_COMMAND") {
    super(message);
    this.name = "CommandCatalogueError";
    this.code = code;
  }
}

/**
Resolve the fixed argument vector for one invocation.

Every declared parameter is required: an optional parameter would have to
drop an argument element, and dropping one shifts the vector the catalogue
describes. The input must carry exactly the declared parameters -- an
undeclared one is rejected rather than ignored, so a caller cannot smuggle
an argument past the schema.
*/
export function resolveCommandArguments(
  definition: CommandDefinition,
  input: Readonly<Record<string, unknown>>
): string[] {
  const validated = commandInputSchema(definition).safeParse(input);
  if (!validated.success) {
    // Do not return Zod's raw messages: invalid values or undeclared
    // parameter names can themselves contain sensitive caller content.
    for (const name of Object.keys(input)) {
      if (!Object.hasOwn(definition.parameters, name)) {
        throw new CommandCatalogueError(
          "Command received an undeclared parameter.",
          "UNKNOWN_PARAMETER"
        );
      }
    }
    for (const name of Object.keys(definition.parameters)) {
      if (!Object.hasOwn(input, name) || typeof input[name] !== "string") {
        throw new CommandCatalogueError(
          `Command requires the parameter "${name}".`,
          "MISSING_PARAMETER"
        );
      }
    }
    throw new CommandCatalogueError(
      "Command parameter violates its declared bounds or contains a NUL byte.",
      "INVALID_PARAMETER"
    );
  }
  return definition.args.map((element) => {
    const placeholder = placeholderPattern.exec(element);
    return placeholder ? validated.data[placeholder[1]!]! : element;
  });
}

/** One source for the MCP input schema and parameter validation. */
export function commandInputSchema(definition: CommandDefinition) {
  const shape: Record<string, z.ZodString> = {};
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    shape[name] = z
      .string()
      .min(parameter.minLength)
      .max(parameter.maxLength)
      .refine((value) => !value.includes("\0"), {
        message: "A parameter must not contain a NUL byte"
      })
      .describe(parameter.description);
  }
  return z.strictObject(shape);
}

export const commandResultSchema = z.strictObject({
  commandId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  status: z.enum([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "output_limit",
    // The approved executable could not be started: no process ran, so
    // there is no exit status to report.
    "startup_failure",
    "infrastructure_error"
  ]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean()
});
export type CommandResult = z.infer<typeof commandResultSchema>;
