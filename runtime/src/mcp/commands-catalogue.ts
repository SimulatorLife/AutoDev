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

export const commandDefinitionSchema = z
  .strictObject({
    description: z.string().trim().min(1).max(500),
    executable: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.+-]+$/u),
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
  commands: z.record(parameterName, commandDefinitionSchema)
});

export type CommandParameter = z.infer<typeof commandParameterSchema>;
export type CommandDefinition = z.infer<typeof commandDefinitionSchema>;
export type CommandCatalogue = z.infer<typeof commandCatalogueSchema>;

export function parseCommandCatalogue(input: unknown): CommandCatalogue {
  return commandCatalogueSchema.parse(input);
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
  const declared = Object.keys(definition.parameters);
  const provided = Object.keys(input);
  for (const name of provided) {
    if (!Object.hasOwn(definition.parameters, name)) {
      throw new CommandCatalogueError(
        `Command does not accept the parameter "${name}".`,
        "UNKNOWN_PARAMETER"
      );
    }
  }
  const arguments_: string[] = [];
  for (const element of definition.args) {
    const placeholder = placeholderPattern.exec(element);
    if (!placeholder) {
      arguments_.push(element);
      continue;
    }
    const name = placeholder[1]!;
    const parameter = definition.parameters[name]!;
    const value = input[name];
    if (typeof value !== "string") {
      throw new CommandCatalogueError(
        `Command requires the parameter "${name}".`,
        "MISSING_PARAMETER"
      );
    }
    if (value.includes("\0")) {
      throw new CommandCatalogueError(
        `The parameter "${name}" must not contain a NUL byte.`,
        "INVALID_PARAMETER"
      );
    }
    if (value.length < parameter.minLength || value.length > parameter.maxLength) {
      throw new CommandCatalogueError(
        `The parameter "${name}" must be between ${parameter.minLength} and ${parameter.maxLength} characters.`,
        "INVALID_PARAMETER"
      );
    }
    arguments_.push(value);
  }
  for (const name of declared) {
    if (!Object.hasOwn(input, name)) {
      throw new CommandCatalogueError(
        `Command requires the parameter "${name}".`,
        "MISSING_PARAMETER"
      );
    }
  }
  return arguments_;
}

/**
The JSON Schema for one command's input, derived from its parameters.

The schema is what the MCP client sees, so it is derived from the same
declaration the executor enforces rather than written twice.
*/
export function commandInputSchema(
  definition: CommandDefinition
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    properties[name] = {
      type: "string",
      description: parameter.description,
      minLength: parameter.minLength,
      maxLength: parameter.maxLength
    };
    required.push(name);
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

export const commandResultSchema = z.strictObject({
  commandId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  status: z.enum([
    "succeeded",
    "failed",
    "cancelled",
    "timed_out",
    "output_limit",
    "infrastructure_error"
  ]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean()
});
export type CommandResult = z.infer<typeof commandResultSchema>;
