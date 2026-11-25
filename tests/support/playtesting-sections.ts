/**
The sections a playtest analysis must report.

`docs/playtesting-target-state.md` declares them as the contract for a
review; the playtest-analysis skill and the playtest-analyst role prompt
both have to carry every one of them. The list lives here so the two
documents are checked against one contract instead of two copies of it.

Each entry names the section as the canonical document states it and the
phrase a document has to carry, because the two documents phrase the same
section slightly differently.
*/
export const REQUIRED_REPORT_SECTIONS = [
  { canonical: "provenance/coverage", keyword: "provenance" },
  {
    canonical: "chronological episode summary",
    keyword: "chronological episode summary"
  },
  { canonical: "authoritative metrics", keyword: "authoritative metrics" },
  {
    canonical: "scored experience dimensions",
    keyword: "scored experience dimensions"
  },
  {
    canonical: "evidence-linked observations",
    keyword: "evidence-linked observations"
  },
  {
    canonical: "alternative explanations",
    keyword: "alternative explanations"
  },
  {
    canonical: "cross-session context",
    keyword: "cross-session context"
  },
  {
    canonical: "testable hypotheses/experiments",
    keyword: "testable hypotheses"
  },
  {
    canonical: "decision on evidence status",
    keyword: "evidence[- ]status"
  },
  { canonical: "suggested follow-up", keyword: "suggested follow-up" }
] as const;

/**
Assert that a document carries every required report section.

A review missing a section is invalid, so the contract is that each one is
present, not that it is phrased in a particular way.
*/
export function assertReportSections(
  document: string,
  label: string
): void {
  for (const section of REQUIRED_REPORT_SECTIONS) {
    if (!new RegExp(section.keyword, "iu").test(document)) {
      throw new Error(`${label} is missing the report section: ${section.canonical}`);
    }
  }
}
