import re
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync"
SHADOW_ROOT = REPO_ROOT / "tests/fixtures/rulesync-shadow"
WORKFLOW_PATH = REPO_ROOT / ".github/workflows/rulesync-mcp-shadow-drift.yml"
RULESYNC_CONFIG_PATH = REPO_ROOT / "rulesync.jsonc"

# `.rulesync/skills` is the single canonical skill source; every AutoDev skill
# lives there and is projected into each target's shadow.
EXPECTED_SKILLS = (
    "ccc",
    "code-simplification",
    "diagnosing-bugs",
    "doubt-driven-development",
    "improve-codebase-architecture",
    "lsp-mcp-server",
    "orchestration",
    "remove-legacy-shims",
    "resolve-merge-conflicts",
    "writing-agent-skills",
)
# Non-SKILL.md files that must be carried byte-identically into projections.
NESTED_SKILL_FILES = (
    "ccc/references/management.md",
    "ccc/references/settings.md",
    "resolve-merge-conflicts/THIRD_PARTY_NOTICES.md",
    "resolve-merge-conflicts/scripts/extract_conflict_context.py",
)
# Codex UI metadata sidecar. Rulesync's codexcli target composes this file only
# from a `codexcli:` frontmatter section and drops a raw copy; other targets
# copy it verbatim. Live Codex reads it through the installer's skill symlink.
OPENAI_YAML = "orchestration/agents/openai.yaml"
EXPECTED_SKILL_PATH = {
    "codexcli": ".agents/skills",
    "claudecode": ".claude/skills",
    "copilot": ".github/skills",
    "antigravity-cli": ".agents/skills",
}
CCC_REFERENCE_FILES = ("management.md", "settings.md")
EXPECTED_SKILL_TARGETS = ("codexcli", "claudecode", "copilot", "antigravity-cli")


def _split_frontmatter(text):
    if not text.startswith("---\n"):
        raise AssertionError("file does not start with YAML frontmatter delimiter")
    end = text.find("\n---\n", 3)
    if end == -1:
        raise AssertionError("file missing closing YAML frontmatter delimiter")
    return text[: end + 5], text[end + 5 :]


def _normalize_description(value):
    return re.sub(r"\s+", " ", value).strip().strip(chr(39) + chr(34))


def _source_body(skill_name):
    source = SOURCE_ROOT / "skills" / skill_name / "SKILL.md"
    _, body = _split_frontmatter(source.read_text())
    return body.strip("\n")


def _shadow_body(target, skill_name):
    rel_root = EXPECTED_SKILL_PATH[target]
    shadow = SHADOW_ROOT / rel_root / skill_name / "SKILL.md"
    _, body = _split_frontmatter(shadow.read_text())
    return body.strip("\n")


def _source_frontmatter(skill_name):
    source = SOURCE_ROOT / "skills" / skill_name / "SKILL.md"
    front, _ = _split_frontmatter(source.read_text())
    return front


def _shadow_frontmatter(skill_name, target):
    rel_root = EXPECTED_SKILL_PATH[target]
    shadow = SHADOW_ROOT / rel_root / skill_name / "SKILL.md"
    front, _ = _split_frontmatter(shadow.read_text())
    return front


class RulesyncSkillsShadowTests(unittest.TestCase):
    def test_rulesync_skills_source_only_contains_expected_skills(self):
        skills_root = SOURCE_ROOT / "skills"
        self.assertTrue(skills_root.is_dir(), msg=f"missing source skills dir: {skills_root}")
        names = sorted(p.name for p in skills_root.iterdir() if p.is_dir())
        self.assertEqual(
            tuple(names),
            EXPECTED_SKILLS,
            msg=".rulesync/skills must contain exactly the canonical AutoDev skills",
        )

    def test_rulesync_skills_source_carries_codex_openai_yaml(self):
        sidecar = SOURCE_ROOT / "skills" / OPENAI_YAML
        self.assertTrue(sidecar.is_file(), msg=f"canonical source must keep {OPENAI_YAML} for live Codex")
        self.assertFalse(sidecar.is_symlink())

    def test_ccc_skill_includes_references_management_and_settings(self):
        references = SOURCE_ROOT / "skills" / "ccc" / "references"
        self.assertTrue(references.is_dir(), msg=f"missing {references}")
        present = {p.name for p in references.iterdir() if p.is_file()}
        for required in CCC_REFERENCE_FILES:
            self.assertIn(
                required,
                present,
                msg=f"ccc skill must ship references/{required} for source/shadow parity",
            )

    def test_rulesync_config_declares_skills_feature(self):
        text = RULESYNC_CONFIG_PATH.read_text()
        match = re.search(r'"features"\s*:\s*\[([^\]]*)\]', text)
        self.assertIsNotNone(match, msg="rulesync.jsonc must declare a features array")
        features = [item.strip().strip('"') for item in match.group(1).split(",") if item.strip()]
        self.assertIn("skills", features)
        self.assertIn("mcp", features)
        self.assertIn("rules", features)

    def test_rulesync_workflow_uses_skills_feature(self):
        text = WORKFLOW_PATH.read_text()
        match = re.search(r"--features\s+(\S+)", text)
        self.assertIsNotNone(match, msg="rulesync drift workflow must declare --features")
        features = match.group(1).replace(" ", "")
        self.assertEqual(
            features,
            "mcp,rules,skills,hooks",
            msg="drift workflow must generate mcp,rules,skills,hooks so shadows stay in lockstep",
        )

    def test_pinned_rulesync_generates_per_target_skill_paths(self):
        before_shadow = sorted(p.relative_to(SHADOW_ROOT).as_posix() for p in SHADOW_ROOT.rglob("*"))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for target in EXPECTED_SKILL_TARGETS:
                with self.subTest(target=target):
                    result = subprocess.run(
                        [
                            "pnpm", "exec", "rulesync", "generate",
                            "--input-roots", str(SOURCE_ROOT),
                            "--targets", target,
                            "--features", "skills",
                            "--output-roots", str(root / target),
                            "--delete", "--silent",
                        ],
                        cwd=REPO_ROOT,
                        capture_output=True,
                        text=True,
                        timeout=60,
                    )
                    self.assertEqual(
                        result.returncode,
                        0,
                        msg=(
                            f"rulesync skills generation failed for {target}: "
                            f"STDOUT={result.stdout}\nSTDERR={result.stderr}"
                        ),
                    )
                    rel_root = EXPECTED_SKILL_PATH[target]
                    for skill in EXPECTED_SKILLS:
                        skill_dir = root / target / rel_root / skill
                        self.assertTrue(
                            skill_dir.is_dir(),
                            msg=f"{target} must emit skill at {skill_dir}",
                        )
                        self.assertTrue(
                            (skill_dir / "SKILL.md").is_file(),
                            msg=f"{target} must emit SKILL.md under {skill_dir}",
                        )
                    for nested in NESTED_SKILL_FILES:
                        self.assertEqual(
                            (root / target / rel_root / nested).read_bytes(),
                            (SOURCE_ROOT / "skills" / nested).read_bytes(),
                            msg=f"{target} must carry {nested} byte-identically",
                        )
                    projected_sidecar = root / target / rel_root / OPENAI_YAML
                    if target == "codexcli":
                        self.assertFalse(
                            projected_sidecar.exists(),
                            msg="codexcli composes openai.yaml only from codexcli frontmatter",
                        )
                    else:
                        self.assertEqual(
                            projected_sidecar.read_bytes(),
                            (SOURCE_ROOT / "skills" / OPENAI_YAML).read_bytes(),
                            msg=f"{target} copies {OPENAI_YAML} verbatim",
                        )
                    unexpected = {
                        p.name
                        for p in (root / target / rel_root).iterdir()
                        if p.is_dir() and p.name not in EXPECTED_SKILLS
                    }
                    self.assertEqual(
                        unexpected,
                        set(),
                        msg=(
                            f"{target} shadow must contain only the canonical skills; "
                            f"unexpected dirs: {sorted(unexpected)}"
                        ),
                    )
        after_shadow = sorted(p.relative_to(SHADOW_ROOT).as_posix() for p in SHADOW_ROOT.rglob("*"))
        self.assertEqual(
            after_shadow,
            before_shadow,
            msg="tracked shadow fixtures must not change during isolated generation",
        )

    def test_tracked_shadow_skill_bodies_match_source_bodies(self):
        for skill in EXPECTED_SKILLS:
            source_body = _source_body(skill)
            for target in EXPECTED_SKILL_TARGETS:
                with self.subTest(skill=skill, target=target):
                    self.assertEqual(
                        _shadow_body(target, skill),
                        source_body,
                        msg=(
                            f"body of {target} shadow for skill {skill!r} must match "
                            f".rulesync/skills/{skill}/SKILL.md body"
                        ),
                    )

    def test_tracked_shadow_skill_references_match_source(self):
        for target in EXPECTED_SKILL_TARGETS:
            rel_root = EXPECTED_SKILL_PATH[target]
            with self.subTest(target=target):
                for nested in NESTED_SKILL_FILES:
                    shadow = SHADOW_ROOT / rel_root / nested
                    self.assertTrue(shadow.is_file(), msg=f"{target} shadow must carry {nested}")
                    self.assertEqual(
                        shadow.read_bytes(),
                        (SOURCE_ROOT / "skills" / nested).read_bytes(),
                        msg=f"{target} {nested} must be byte-identical to .rulesync/skills/{nested}",
                    )

    def test_tracked_shadow_frontmatter_normalizes_description(self):
        for skill in EXPECTED_SKILLS:
            source_front = _source_frontmatter(skill)
            source_match = re.search(
                r"^description:\s*(.*?)\s*$",
                source_front,
                flags=re.DOTALL | re.MULTILINE,
            )
            self.assertIsNotNone(
                source_match,
                msg=f"source skill {skill!r} must declare a description in frontmatter",
            )
            source_description = source_match.group(1).strip()
            self.assertFalse(
                source_description.startswith(">-"),
                msg=(
                    f"source skill {skill!r} description must be single-line; shadow "
                    "renders it as YAML folded block scalar (>-)"
                ),
            )
            for target in EXPECTED_SKILL_TARGETS:
                with self.subTest(skill=skill, target=target):
                    shadow_front = _shadow_frontmatter(skill, target)
                    self.assertIsNotNone(
                        re.search(r"^description:\s*>-\s*$", shadow_front, flags=re.MULTILINE),
                        msg=(
                            f"{target} shadow frontmatter for {skill!r} must use the YAML "
                            "folded block scalar (>-...) form"
                        ),
                    )
                    shadow_match = re.search(
                        r"^description:\s*>-\s*\n(?P<body>(?:^[ \t].*\n?)+)",
                        shadow_front,
                        flags=re.MULTILINE,
                    )
                    self.assertIsNotNone(
                        shadow_match,
                        msg=(
                            f"{target} shadow frontmatter for {skill!r} must contain a "
                            "multi-line description block after >-"
                        ),
                    )
                    shadow_description = _normalize_description(shadow_match.group("body"))
                    self.assertEqual(
                        shadow_description,
                        _normalize_description(source_description),
                        msg=(
                            f"{target} shadow description for {skill!r} must equal the "
                            "source description after whitespace normalization"
                        ),
                    )

    def test_tracked_shadow_skill_frontmatter_preserves_name(self):
        for skill in EXPECTED_SKILLS:
            for target in EXPECTED_SKILL_TARGETS:
                with self.subTest(skill=skill, target=target):
                    rel_root = EXPECTED_SKILL_PATH[target]
                    shadow = SHADOW_ROOT / rel_root / skill / "SKILL.md"
                    front, _ = _split_frontmatter(shadow.read_text())
                    name_match = re.search(
                        rf"^name:\s*{re.escape(skill)}\s*$",
                        front,
                        flags=re.MULTILINE,
                    )
                    self.assertIsNotNone(
                        name_match,
                        msg=f"{target} shadow for {skill!r} must keep name: {skill}",
                    )

    def test_tracked_shadow_carries_openai_yaml_once_per_skill_root(self):
        # `.agents/skills` is shared by codexcli and antigravity-cli; the
        # combined generation keeps Antigravity's verbatim copy there.
        source = (SOURCE_ROOT / "skills" / OPENAI_YAML).read_bytes()
        roots = sorted(set(EXPECTED_SKILL_PATH.values()))
        self.assertEqual(
            sorted(path.relative_to(SHADOW_ROOT).as_posix() for path in SHADOW_ROOT.rglob("openai.yaml")),
            sorted(f"{root}/{OPENAI_YAML}" for root in roots),
        )
        for root in roots:
            with self.subTest(root=root):
                self.assertEqual((SHADOW_ROOT / root / OPENAI_YAML).read_bytes(), source)

    def test_tracked_rulesync_generate_passes_check(self):
        with tempfile.TemporaryDirectory() as temp:
            input_root = Path(temp)
            rule_path = input_root / "rules" / "overview.md"
            rule_path.parent.mkdir(parents=True)
            rule_path.write_bytes(
                b"---\n"
                b"root: true\n"
                b"targets: [\"*\"]\n"
                b"description: \"AutoDev shared workspace instructions for all AI tooling\"\n"
                b"globs: [\"**/*\"]\n"
                b"---\n"
                + (SOURCE_ROOT / "rules" / "overview.md").read_bytes()
            )
            result = subprocess.run(
                [
                    "pnpm", "exec", "rulesync", "generate",
                    "--config", str(RULESYNC_CONFIG_PATH.relative_to(REPO_ROOT)),
                    "--input-roots", str(input_root),
                    "--check", "--silent",
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
        self.assertEqual(
            result.returncode,
            0,
            msg=(
                "rulesync generate --config rulesync.jsonc --check must pass\n"
                f"STDOUT={result.stdout}\nSTDERR={result.stderr}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
