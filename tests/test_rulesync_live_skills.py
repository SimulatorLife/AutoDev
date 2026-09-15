import re
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync" / "skills"
LIVE_ROOT = REPO_ROOT / ".github" / "skills"
SHADOW_ROOT = REPO_ROOT / "tests" / "fixtures" / "rulesync-shadow" / ".github" / "skills"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "rulesync-mcp-shadow-drift.yml"
SKILLS = ("ccc", "lsp-mcp-server", "orchestration")


def _frontmatter_and_body(path):
    text = path.read_text()
    match = re.match(r"\A---\n(?P<front>.*?)\n---\n(?P<body>.*)\Z", text, re.DOTALL)
    if not match:
        raise AssertionError(f"missing Rulesync frontmatter: {path}")
    return match.group("front"), match.group("body")


def _description(frontmatter):
    match = re.search(
        r"^description:\s*>-\s*\n(?P<body>(?:^[ \t].*\n?)+)",
        frontmatter,
        re.MULTILINE,
    )
    if match:
        value = match.group("body")
    else:
        match = re.search(r"^description:\s*(?P<value>.+)$", frontmatter, re.MULTILINE)
        if not match:
            raise AssertionError("frontmatter must declare a description")
        value = match.group("value")
    return re.sub(r"\s+", " ", value).strip().strip("'\"")


class RulesyncLiveSkillsTests(unittest.TestCase):
    def test_live_copilot_skills_have_exactly_the_cutover_surface(self):
        self.assertEqual(
            sorted(path.name for path in LIVE_ROOT.iterdir() if path.is_dir()),
            sorted(SKILLS),
        )
        for skill in SKILLS:
            directory = LIVE_ROOT / skill
            self.assertEqual(
                sorted(path.name for path in directory.iterdir()),
                ["SKILL.md"],
                msg=f"live {skill} skill must not include generated references or other files",
            )

    def test_non_cutover_canonical_skills_are_generated_but_not_promoted(self):
        # `.rulesync/skills` is the canonical source for every AutoDev skill,
        # but the live Copilot cutover stays limited to SKILLS: the rest are
        # projected for Copilot and deliberately absent from `.github/skills`.
        canonical = {path.name for path in SOURCE_ROOT.iterdir() if path.is_dir()}
        self.assertTrue(set(SKILLS) < canonical)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "generated"
            result = subprocess.run(
                [
                    "pnpm", "exec", "rulesync", "generate",
                    "--input-roots", ".rulesync",
                    "--targets", "copilot",
                    "--features", "skills",
                    "--output-roots", str(output),
                    "--delete", "--silent",
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, msg=result.stderr)
            generated = {path.name for path in (output / ".github" / "skills").iterdir() if path.is_dir()}
        self.assertEqual(generated, canonical)
        for skill in sorted(canonical - set(SKILLS)):
            with self.subTest(skill=skill):
                self.assertFalse((LIVE_ROOT / skill).exists())

    def test_live_bodies_and_normalized_frontmatter_match_copilot_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "generated"
            result = subprocess.run(
                [
                    "pnpm", "exec", "rulesync", "generate",
                    "--input-roots", ".rulesync",
                    "--targets", "copilot",
                    "--features", "skills",
                    "--output-roots", str(output),
                    "--delete", "--silent",
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, msg=result.stderr)
            for skill in SKILLS:
                source_front, source_body = _frontmatter_and_body(SOURCE_ROOT / skill / "SKILL.md")
                generated_front, generated_body = _frontmatter_and_body(
                    output / ".github" / "skills" / skill / "SKILL.md"
                )
                live_front, live_body = _frontmatter_and_body(LIVE_ROOT / skill / "SKILL.md")
                self.assertEqual(live_body.strip("\n"), source_body.strip("\n"))
                self.assertEqual(live_body.strip("\n"), generated_body.strip("\n"))
                self.assertRegex(
                    generated_front,
                    re.compile(rf"^name:\s*{re.escape(skill)}$", re.MULTILINE),
                )
                self.assertEqual(_description(generated_front), _description(source_front))
                self.assertEqual(live_front, generated_front)

    def test_ccc_references_remain_shadow_only(self):
        for relative in ("management.md", "settings.md"):
            self.assertTrue((SOURCE_ROOT / "ccc" / "references" / relative).is_file())
            self.assertTrue((SHADOW_ROOT / "ccc" / "references" / relative).is_file())
            self.assertFalse((LIVE_ROOT / "ccc" / "references" / relative).exists())

    def test_workflow_preserves_shadow_checks_and_only_adds_live_skills_check(self):
        workflow = WORKFLOW.read_text()
        self.assertIn("Check live rules from an ephemeral Rulesync input root", workflow)
        self.assertIn("--features rules", workflow)
        self.assertIn("Detect Rulesync drift against tracked shadow fixtures", workflow)
        self.assertIn("--features mcp,rules,skills,hooks", workflow)
        live_skills = workflow.split("Check live Copilot skills from an ephemeral Rulesync output root", 1)[1]
        self.assertIn("--features skills", live_skills)
        self.assertIn(".github/skills", live_skills)
        self.assertNotIn("--features mcp", live_skills)
        self.assertNotIn("--features hooks", live_skills)
        self.assertNotIn("--features permissions", live_skills)
        self.assertNotIn("--features mcp", workflow.split("Check live rules from an ephemeral Rulesync input root", 1)[1].split("Check live Copilot skills", 1)[0])


if __name__ == "__main__":
    unittest.main()
