import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/** Comments describe this defect, so they must not be able to trip the scan. */
function stripComments(src: string): string {
  return src
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/(^|[^:])\/\/.*$/gmu, "$1");
}

test("no template literal is quoted as a plain string", () => {
  // `className: "`${CALLOUT_ERROR_CLASS} mb-3`"` renders the literal source text
  // as a class attribute. The element still appears, still has its text, still
  // has its role -- so the only thing lost is the styling, which is the thing
  // that says "this is broken". Two sites in the Console had it, and neither
  // was caught by a page-level test because each sat in a branch the suite
  // walked past.
  //
  // This is a source scan rather than a render test because the defect is a
  // source shape: it renders identically wrong wherever it appears, and the
  // branch that triggers it is usually not the one the fixtures drive.
  const offenders: string[] = [];
  for (const file of [
    ...sourceFiles(join(ROOT, "src")),
    ...sourceFiles(join(ROOT, "app"))
  ]) {
    const src = stripComments(readFileSync(file, "utf8"));
    const at = relative(ROOT, file);
    src.split("\n").forEach((line, i) => {
      // A quote immediately wrapping a backtick-delimited expression.
      if (/"`[^"`]*\$\{/.test(line) || /'`[^'`]*\$\{/.test(line)) {
        offenders.push(`${at}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("the scan would notice a quoted template literal if one appeared", () => {
  // The scan above must be capable of failing, or it is decoration. Assert it
  // against the shape it is supposed to catch rather than trusting that the
  // regex and the pattern agree.
  const PATTERN = /"`[^"`]*\$\{/;
  assert.match('className: "`${CALLOUT_ERROR_CLASS} mb-3`"', PATTERN);
  assert.doesNotMatch('className: `${CALLOUT_ERROR_CLASS} mb-3`', PATTERN);
  assert.doesNotMatch("className: CALLOUT_ERROR_CLASS", PATTERN);
});