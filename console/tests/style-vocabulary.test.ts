import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compile } from "tailwindcss";

/**
The Console's styling layer, checked against the stylesheet it actually
produces.

The Console styles itself with Tailwind utilities and one semantic token set
in `app/globals.css`. A utility is therefore a claim about the theme: it says
"this element takes the Console's accent", and the theme answers by emitting
a rule for it. Three things can go wrong with that claim, and none of them
announce themselves -- the page still renders, it just renders differently
from what the source says:

1. The utility names something the theme does not have. `bg-surface-muted`
   and `text-muted-foreground` were such utilities: no token carried those
   names, so Tailwind emitted no rule for them at all and the element wore no
   background and no colour of their own. The hover state that used one of
   them simply never happened.

2. Two utilities in one class string set the same CSS property. The
   stylesheet decides the winner by its own order, not by the order they
   were written in, so one of them is dead and the author never learns which.
   `text-sm` beside `text-xs` is that case, and so is a muted colour beside
   a status colour: the muted one loses, and the status the operator is
   supposed to read never reaches the page.

3. A utility names a raw Tailwind palette value. The Console has one dark
   theme with one token per meaning; `border-l-amber-500` is a palette entry
   pretending to be a product decision, and it is invisible to the contrast
   assertions that check the theme's own tokens.

These are checked against the compiled stylesheet rather than against a
hand-written list of utility names, so a utility the theme does know about is
never reported, and one it does not know about always is.
*/

const consoleRoot = fileURLToPath(new URL("..", import.meta.url));
const globalsCssPath = path.join(consoleRoot, "app", "globals.css");

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, found);
    else if (/\.tsx?$/u.test(entry.name)) found.push(full);
  }
  return found;
}

const sourceFiles = [
  ...collectSourceFiles(path.join(consoleRoot, "app")),
  ...collectSourceFiles(path.join(consoleRoot, "src"))
];

interface ClassUsage {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /**
  Whether the class string was written as a template literal.
  */
  readonly template: boolean;
}

/**
A `className` attribute and the class string it holds.

The leading whitespace and the optional brace are one quantifier rather than
two: two separate `\\s*` runs around an optional `{` can match the same
space in two ways, which is a backtracking trap for no gain.
*/
const CLASS_NAME_PATTERN =
  /className\s*[:=][\s{]*(?:"([^"]*)"|`([\s\S]*?)`| '([^']*)')/gu;

/**
A shared constant and the class string it holds.
*/
const CONSTANT_PATTERN =
  /(?:export )?const (\w+)\s*[:=]\s*([`"'])([\s\S]*?)\2/gu;

/**
A whole class string written as a string literal.
*/
const STRING_LITERAL_PATTERN = /^(?:"([^"]*)"|'([^']*)')$/u;

/**
A class inside a selector.
*/
const CLASS_SELECTOR_PATTERN = /\.((?:\\.|[A-Za-z0-9_-])+)/gu;

/**
A separator between two parts of a selector list, but not one inside an
escaped class name -- `grid-cols-[minmax(0,7rem)_...]` holds a comma of its
own, and splitting on it would cut the name in half.
*/
const SELECTOR_SEPARATOR_PATTERN = /(?<!\\),/u;

/**
Every class string the Console's own source writes.

A template literal counts: the Console composes its classes out of shared
constants, and the composition is what reaches the browser. The quote style
is kept because it decides what the string means: only a template literal
interpolates.
*/
function classUsages(): ClassUsage[] {
  const usages: ClassUsage[] = [];
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(CLASS_NAME_PATTERN)) {
      const text = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (text === "") continue;
      usages.push({
        file: path.relative(consoleRoot, file),
        line: source.slice(0, match.index).split("\n").length,
        text,
        template: match[2] !== undefined
      });
    }
  }
  return usages;
}

/**
A shared constant and the class string it holds.
*/
interface SharedConstant {
  readonly value: string;
  /**
  Whether the constant was written as a template literal.
  */
  readonly template: boolean;
}

/**
The shared constants the source composes its classes out of, by name.
*/
function sharedConstants(): Map<string, SharedConstant> {
  const constants = new Map<string, SharedConstant>();
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(CONSTANT_PATTERN)) {
      const name = match[1];
      const value = match[3];
      if (name === undefined || value === undefined || constants.has(name)) continue;
      constants.set(name, { value, template: match[2] === "`" });
    }
  }
  return constants;
}

/**
The index of the `}` that closes the expression opened just before `start`.

A nested template literal inside the expression is skipped whole, braces and
all, so a `}` inside it cannot close the expression early.
*/
function scanExpression(content: string, start: number): number {
  let depth = 1;
  let cursor = start;
  while (cursor < content.length) {
    const character = content[cursor];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
    } else if (character === "`") {
      cursor = scanNestedTemplate(content, cursor);
      continue;
    }
    cursor += 1;
  }
  return content.length;
}

/**
The index just past the closing backtick of the template literal at `start`.
*/
function scanNestedTemplate(content: string, start: number): number {
  let cursor = start + 1;
  while (cursor < content.length) {
    const character = content[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "`") return cursor + 1;
    if (content.startsWith("${", cursor)) {
      cursor = scanExpression(content, cursor + 2) + 1;
      continue;
    }
    cursor += 1;
  }
  return cursor;
}

/**
A template literal's literal chunks and the expressions between them.

The expressions are read with a scan rather than a pattern, because an
expression can hold a nested template literal of its own --
`${className === undefined ? "" : ` ${className}`}` -- and a pattern that
stopped at the first `}` would read half an expression as a class name.
*/
function templateParts(content: string): {
  readonly chunks: string[];
  readonly expressions: string[];
} {
  const chunks: string[] = [];
  const expressions: string[] = [];
  let chunk = "";
  let index = 0;
  while (index < content.length) {
    if (content[index] === "\\") {
      chunk += content.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (content.startsWith("${", index)) {
      chunks.push(chunk);
      chunk = "";
      const close = scanExpression(content, index + 2);
      expressions.push(content.slice(index + 2, close));
      index = close + 1;
      continue;
    }
    chunk += content[index];
    index += 1;
  }
  chunks.push(chunk);
  return { chunks, expressions };
}

/**
The expression with its quoted text blanked out.

A quoted `:` is punctuation inside a class string, not the branch of a
choice, and the blanking keeps the same length as the original so that an
index into one is an index into the other.
*/
function withoutQuotedText(expression: string): string {
  let result = "";
  let quote: string | null = null;
  for (const character of expression) {
    if (quote === null) {
      if (character === '"' || character === "'") {
        quote = character;
        result += " ";
        continue;
      }
      result += character;
      continue;
    }
    result += " ";
    if (character === quote) quote = null;
  }
  return result;
}

/**
Where the `?` and the `:` of a choice between two values sit, when the
expression is such a choice.
*/
function topLevelTernaryPositions(expression: string): [number, number] | null {
  const bare = withoutQuotedText(expression);
  let depth = 0;
  let question = -1;
  let colon = -1;
  let index = 0;
  for (const character of bare) {
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
    } else if (depth === 0 && character === "?" && question === -1) {
      question = index;
    } else if (
      depth === 0 &&
      character === ":" &&
      question !== -1 &&
      colon === -1
    ) {
      colon = index;
    }
    index += 1;
  }
  if (question === -1 || colon === -1) return null;
  return [question, colon];
}

/**
The two class strings an expression chooses between, or `null` when the
expression is not a choice between class strings.
*/
function ternaryBranches(expression: string): string[] | null {
  const positions = topLevelTernaryPositions(expression);
  if (positions === null) return null;
  const [question, colon] = positions;
  const whenTrue = expression.slice(question + 1, colon).trim();
  const whenFalse = expression.slice(colon + 1).trim();
  const trueMatch = STRING_LITERAL_PATTERN.exec(whenTrue);
  const falseMatch = STRING_LITERAL_PATTERN.exec(whenFalse);
  if (trueMatch === null || falseMatch === null) return null;
  return [
    trueMatch[1] ?? trueMatch[2] ?? "",
    falseMatch[1] ?? falseMatch[2] ?? ""
  ];
}

/**
The class strings one expression can contribute.

`null` means the expression is not something the Console can be asked about
-- a call, a member expression, a condition -- so the class string that
holds it cannot be resolved and the caller skips it rather than guess.
*/
function expressionValues(
  expression: string,
  constants: Map<string, SharedConstant>,
  depth: number
): string[] | null {
  const constant = constants.get(expression);
  if (constant !== undefined) {
    if (!constant.template) return [constant.value];
    // A constant that is itself composed renders into class strings of its
    // own, and each of them is a way this class string can come out.
    return renderedClassStrings(constant.value, constants, true, depth + 1);
  }
  const literal = STRING_LITERAL_PATTERN.exec(expression);
  if (literal !== null) return [literal[1] ?? literal[2] ?? ""];
  // A choice between two class strings: `cond ? "a" : "b"`. Only the two
  // branches of the choice are class strings -- the words the condition
  // compares are not, and a class string that reads them as such would report
  // a utility the theme has never heard of.
  return ternaryBranches(expression);
}

/**
The class strings one `className` value can render.

A shared constant is expanded in place, because that is what the browser
receives. An expression that chooses between class strings is kept as the
alternatives it chooses between: `cond ? "a" : "b"` renders one of them,
never both, so they are two renderings rather than one class string that
happens to name two colours.

Only a template literal interpolates. A plain string is taken literally,
which is what makes an interpolation written inside one visible here
instead of being quietly expanded.
*/
function renderedClassStrings(
  raw: string,
  constants: Map<string, SharedConstant>,
  template: boolean,
  depth = 0
): string[] {
  if (!template) return [raw.replaceAll(/\s+/gu, " ").trim()];
  if (depth > 10) return [];
  const { chunks, expressions } = templateParts(raw);
  let renderings = [""];
  for (const [index, expression] of expressions.entries()) {
    const chunk = chunks[index] ?? "";
    const values = expressionValues(expression.trim(), constants, depth);
    if (values === null) return [];
    renderings = renderings.flatMap((rendering) =>
      values.map((value) => `${rendering} ${chunk} ${value}`)
    );
    if (renderings.length > 32) return [];
  }
  const tail = chunks.at(-1) ?? "";
  return renderings.map((rendering) =>
    `${rendering} ${tail}`.replaceAll(/\s+/gu, " ").trim()
  );
}

interface RenderedClass {
  readonly usage: ClassUsage;
  readonly tokens: string[];
}

/**
Every class string the Console renders, with the classes of each rendering.
*/
function renderedClasses(): RenderedClass[] {
  const constants = sharedConstants();
  const rendered: RenderedClass[] = [];
  for (const usage of classUsages()) {
    const renderings = renderedClassStrings(
      usage.text,
      constants,
      usage.template
    );
    for (const rendering of renderings) {
      rendered.push({
        usage,
        tokens: rendering.split(/\s+/u).filter((token) => token !== "")
      });
    }
  }
  return rendered;
}

/**
The declarations a rule body makes at its own level.

A rule body can hold a nested at-rule -- Tailwind wraps its colour-mixed
borders in an `@supports` -- and the prelude of that nested rule is not a
declaration of the outer rule. Reading the body flat would take `color`
out of `@supports (color: ...)` and call it a property the border utility
sets.
*/
function ownDeclarations(body: string): string[] {
  const declarations: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const character of body) {
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (character === ";") {
      declarations.push(buffer);
      buffer = "";
      continue;
    }
    buffer += character;
  }
  declarations.push(buffer);
  return declarations
    .map((declaration) => declaration.trim())
    .filter(
      (declaration) => declaration !== "" && !declaration.startsWith("@")
    );
}

/**
The property each declaration sets, and the value it sets it to.
*/
function declarationMap(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of ownDeclarations(body)) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (property === "" || property.includes("(") || declarations.has(property)) continue;
    declarations.set(property, value);
  }
  return declarations;
}

interface CompiledUtility {
  /**
  The selector the utility applies to, with its own class removed.
  */
  readonly shape: string;
  /**
  The property each declaration sets, with the value it sets it to.
  */
  readonly declarations: Map<string, string>;
}

interface CssBlock {
  readonly selector: string;
  readonly body: string;
}

/**
The index of the `}` that closes the block opened at `open`.
*/
function matchingBrace(text: string, open: number): number {
  let depth = 1;
  let cursor = open + 1;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === "{") depth += 1;
    else if (text[cursor] === "}") depth -= 1;
    cursor += 1;
  }
  return cursor - 1;
}

/**
The stylesheet's blocks, one layer at a time.
*/
function cssBlocks(text: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open === -1) return blocks;
    const prelude = text.slice(index, open);
    const close = matchingBrace(text, open);
    // The text before a block's opening brace still carries the previous
    // block's closing brace, so the selector is what follows it.
    const selector = prelude.slice(prelude.lastIndexOf("}") + 1).trim();
    blocks.push({ selector, body: text.slice(open + 1, close) });
    index = close + 1;
  }
  return blocks;
}

/**
Record one class and what it declares.

A class can be declared by more than one rule -- a utility and its variant
share a name -- so the declarations of the rules that meet are merged, with
the first rule that names a property holding it.
*/
function recordUtility(
  utilities: Map<string, CompiledUtility>,
  escaped: string,
  part: string,
  declarations: Map<string, string>
): void {
  const utility = escaped.replaceAll(/\\(.)/gu, "$1");
  const shape = part.trim().replace(escaped, "").trim();
  const known = utilities.get(utility);
  if (known === undefined) {
    utilities.set(utility, { shape, declarations: new Map(declarations) });
    return;
  }
  for (const [property, value] of declarations) {
    if (!known.declarations.has(property)) {
      known.declarations.set(property, value);
    }
  }
}

/**
Every class in a stylesheet, with what it declares.

The stylesheet is walked rather than pattern-matched: the utilities live
inside `@layer` blocks, and a rule's body can hold a nested at-rule of its
own. A class can also sit inside a `:where(...)` wrapper -- Tailwind writes
`space-y-2` as `:where(.space-y-2 > :not(:last-child))` -- so the classes
are read out of the selector rather than off the front of it.

The shape is what tells two utilities that set the same property apart when
they set it on different things: `placeholder-fg-muted` and `text-fg-muted`
both set a colour, but one of them colours the placeholder and the other
colours the text.
*/
function classRules(css: string): Map<string, CompiledUtility> {
  const utilities = new Map<string, CompiledUtility>();
  collectClassRules(utilities, css);
  return utilities;
}

function collectClassRules(
  utilities: Map<string, CompiledUtility>,
  text: string
): void {
  for (const block of cssBlocks(text)) {
    if (block.selector.startsWith("@")) {
      collectClassRules(utilities, block.body);
      continue;
    }
    const declarations = declarationMap(block.body);
    for (const part of block.selector.split(SELECTOR_SEPARATOR_PATTERN)) {
      for (const candidate of part.matchAll(CLASS_SELECTOR_PATTERN)) {
        recordUtility(utilities, candidate[1] ?? "", part, declarations);
      }
    }
  }
}

/**
The Tailwind package's own stylesheet, which `app/globals.css` imports.

The Console's stylesheet opens with `@import "tailwindcss"`, so compiling it
means resolving that import: the package's `index.css` sits next to its
module entry point.
*/
const tailwindPackageRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("tailwindcss")))
);

async function compiledUtilities(
  renderings: RenderedClass[]
): Promise<Map<string, CompiledUtility>> {
  const css = readFileSync(globalsCssPath, "utf8");
  const compiler = await compile(css, {
    base: consoleRoot,
    loadStylesheet: async (id: string, base: string) => {
      const candidates = [
        path.resolve(base, id),
        path.resolve(base, `${id}.css`),
        path.join(tailwindPackageRoot, `${id}.css`),
        path.join(tailwindPackageRoot, "index.css")
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          return {
            path: candidate,
            base: path.dirname(candidate),
            content: readFileSync(candidate, "utf8")
          };
        }
      }
      throw new Error(`cannot resolve stylesheet ${id}`);
    }
  });
  const tokens = [
    ...new Set(
      renderings.flatMap((rendering) =>
        rendering.tokens.filter((token) => !token.includes(":"))
      )
    )
  ];
  return classRules(compiler.build(tokens));
}

/**
The properties two utilities fight over when they set the same one.

These are the Console's *type and colour* treatments: a font size, a text
colour, a background, a border, a cursor, a weight. Layout properties are
not here on purpose -- a caller overriding the padding of a shared control
chrome is a normal thing to do, and the stylesheet resolves it in the
caller's favour by the order the scale is written in.
*/
const CONTESTED_PROPERTIES = new Set([
  "font-size",
  "color",
  "background-color",
  "border-color",
  "opacity",
  "cursor",
  "font-family",
  "font-weight",
  "text-transform",
  "letter-spacing"
]);

/**
The colour-utility prefixes a raw palette entry can hide behind.
*/
const PALETTE_PREFIXES = [
  "accent",
  "bg",
  "border",
  "caret",
  "decoration",
  "divide",
  "fill",
  "from",
  "outline",
  "placeholder",
  "ring",
  "shadow",
  "stroke",
  "text",
  "to",
  "via"
];

/**
The palette entries themselves: the names Tailwind ships with a number.
*/
const PALETTE_NAMES = [
  "amber",
  "blue",
  "cyan",
  "emerald",
  "fuchsia",
  "gray",
  "green",
  "indigo",
  "lime",
  "neutral",
  "orange",
  "pink",
  "purple",
  "red",
  "rose",
  "sky",
  "slate",
  "stone",
  "teal",
  "violet",
  "yellow",
  "zinc"
];

/**
The side modifiers a directional utility carries.
*/
const PALETTE_DIRECTIONS = ["b", "e", "l", "r", "s", "t", "x", "y"];

/**
A raw palette utility, in the plain form.

`bg-amber-500` is a palette entry pretending to be a product decision.
*/
const RAW_PALETTE_PATTERN = new RegExp(
  String.raw`(?:${PALETTE_PREFIXES.join("|")})-(?:${PALETTE_NAMES.join("|")})-[0-9]{2,3}\b`,
  "u"
);

/**
A raw palette utility, in the directional form.

`border-l-amber-500` is the same palette entry as `border-amber-500`, and
the directional form is what a left accent bar is written as.
*/
const RAW_PALETTE_DIRECTIONAL_PATTERN = new RegExp(
  String.raw`(?:${PALETTE_PREFIXES.join("|")})-(?:${PALETTE_DIRECTIONS.join("|")})-(?:${PALETTE_NAMES.join("|")})-[0-9]{2,3}\b`,
  "u"
);

/**
Whether a class names a raw Tailwind palette entry.
*/
function isRawPaletteUtility(token: string): boolean {
  return (
    RAW_PALETTE_PATTERN.test(token) ||
    RAW_PALETTE_DIRECTIONAL_PATTERN.test(token)
  );
}

/**
Whether a class is a `group`/`peer` marker rather than a utility.

A marker names the element a `group-*` variant reads, and no rule is ever
emitted for it.
*/
function isMarker(token: string): boolean {
  const slash = token.indexOf("/");
  const name = slash === -1 ? token : token.slice(0, slash);
  if (name !== "group" && name !== "peer") return false;
  if (slash === -1) return true;
  const suffix = token.slice(slash + 1);
  return /^[A-Za-z0-9_-]+$/u.test(suffix);
}

const renderings = renderedClasses();
const compiled = await compiledUtilities(renderings);

test("every utility the Console writes is one the theme knows", () => {
  const unknown: string[] = [];
  for (const rendering of renderings) {
    for (const token of rendering.tokens) {
      if (token === "" || token.includes(":") || token.includes("${") || isMarker(token)) continue;
      if (!compiled.has(token)) {
        unknown.push(
          `${rendering.usage.file}:${String(rendering.usage.line)} ${token}`
        );
      }
    }
  }
  assert.deepEqual(
    unknown,
    [],
    "a utility the theme does not answer emits no rule at all:\n" +
      unknown.join("\n")
  );
});

test("no class string carries a literal interpolation", () => {
  // An interpolation written inside a string that is not a template literal
  // renders as the literal text `${...}`, so the element wears the classes
  // around it and none of the ones the constant held. The page still renders,
  // the link still navigates, and nothing announces the loss -- which is how
  // five action links lost their accent before this check existed.
  const broken: string[] = [];
  for (const rendering of renderings) {
    for (const token of rendering.tokens) {
      if (!token.includes("${")) continue;
      broken.push(
        `${rendering.usage.file}:${String(rendering.usage.line)} ${token}`
      );
    }
  }
  assert.deepEqual(
    broken,
    [],
    "an interpolation inside a plain string renders as literal text:\n" +
      broken.join("\n")
  );
});

/**
The conflict one class introduces, if it introduces one.

Two utilities fight over a property when they set the *same* one, on the
*same* thing, to a *different* value. The stylesheet then decides the
winner by its own order rather than by the order they were written in, so
one of them is dead and the author never learns which. `text-sm` beside
`text-xs` is that case, and so is a muted colour beside a status colour:
the muted one loses, and the status the operator is supposed to read never
reaches the page.
*/
function conflictsForToken(
  rendering: RenderedClass,
  token: string,
  seen: Map<string, { token: string; value: string }>
): string[] {
  const conflicts: string[] = [];
  if (token === "" || token.includes(":")) return conflicts;
  const utility = compiled.get(token);
  if (utility === undefined) return conflicts;
  for (const [property, value] of utility.declarations) {
    if (!CONTESTED_PROPERTIES.has(property)) continue;
    const key = `${utility.shape}|${property}`;
    const owner = seen.get(key);
    if (owner !== undefined && owner.token !== token && owner.value !== value) {
      conflicts.push(
        `${rendering.usage.file}:${String(rendering.usage.line)} ${owner.token} and ${token} both set ${property}`
      );
      continue;
    }
    seen.set(key, { token, value });
  }
  return conflicts;
}

function conflictsInRendering(rendering: RenderedClass): string[] {
  const conflicts: string[] = [];
  const seen = new Map<string, { token: string; value: string }>();
  for (const token of rendering.tokens) {
    conflicts.push(...conflictsForToken(rendering, token, seen));
  }
  return conflicts;
}

test("no class string writes two utilities for the same property", () => {
  const conflicts: string[] = [];
  for (const rendering of renderings) {
    conflicts.push(...conflictsInRendering(rendering));
  }
  assert.deepEqual(
    conflicts,
    [],
    "one of two utilities for the same property is dead, and the stylesheet decides which:\n" +
      conflicts.join("\n")
  );
});

test("the Console writes no raw Tailwind palette utility", () => {
  const offenders: string[] = [];
  for (const rendering of renderings) {
    for (const token of rendering.tokens) {
      if ((token === "") || !isRawPaletteUtility(token)) continue;
      offenders.push(
        `${rendering.usage.file}:${String(rendering.usage.line)} ${token}`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "the Console has one dark theme with one token per meaning:\n" +
      offenders.join("\n")
  );
});
