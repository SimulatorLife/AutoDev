import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync" / "skills"
INSTALLER = REPO_ROOT / "scripts" / "codex" / "install-codex-integration.sh"
RULESYNC_CONFIG = REPO_ROOT / "rulesync.jsonc"
DRIFT_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "rulesync-mcp-shadow-drift.yml"
COPILOT_SETUP_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "copilot-setup-steps.yml"

TARGETS = ("copilot", "claudecode", "codexcli", "antigravity-cli")
CANONICAL_SKILLS = (
    "autodev-codex-request-capture",
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
# What each tool discovers inside AutoDev, keyed by its repository skill folder
# (Codex and Antigravity share `.agents/skills`). Every other canonical skill
# reaches local tools at user level through the installer, so projecting it here
# as well would list it twice. Copilot's cloud agent has no user level, so the
# Copilot folder also carries the portable skills it needs.
REPOSITORY_SKILLS = {
    ".github/skills": ("autodev-codex-request-capture", "ccc", "lsp-mcp-server", "orchestration"),
    ".claude/skills": ("autodev-codex-request-capture",),
    ".agents/skills": ("autodev-codex-request-capture",),
}


def _rulesync(output_root, *mode):
    # The live configuration itself, redirected to a temporary output root.
    return subprocess.run(
        [
            "pnpm", "exec", "rulesync", "generate",
            "--config", "rulesync.jsonc",
            "--output-roots", str(output_root),
            *mode, "--silent",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _split_frontmatter(path):
    match = re.match(r"\A---\n(?P<front>.*?)\n---\n(?P<body>.*)\Z", path.read_text(), re.DOTALL)
    if not match:
        raise AssertionError(f"missing skill frontmatter: {path}")
    return match.group("front"), match.group("body").strip("\n")


def _description(frontmatter):
    folded = re.search(r"^description:\s*>-\s*\n(?P<body>(?:^[ \t].*\n?)+)", frontmatter, re.MULTILINE)
    value = folded.group("body") if folded else re.search(r"^description:\s*(.+)$", frontmatter, re.MULTILINE).group(1)
    return re.sub(r"\s+", " ", value).strip().strip("'\"")


def _files(directory):
    return sorted(path.relative_to(directory) for path in directory.rglob("*") if path.is_file())


class RulesyncSkillsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory()
        cls.generated = Path(cls._temp.name) / "generated"
        result = _rulesync(cls.generated)
        if result.returncode != 0:
            raise AssertionError(f"rulesync skills generation failed: {result.stdout}\n{result.stderr}")

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def test_canonical_source_holds_every_skill(self):
        self.assertEqual(
            tuple(sorted(path.name for path in SOURCE_ROOT.iterdir() if path.is_dir())),
            CANONICAL_SKILLS,
        )
        for skill in CANONICAL_SKILLS:
            with self.subTest(skill=skill):
                document = SOURCE_ROOT / skill / "SKILL.md"
                self.assertTrue(document.is_file())
                self.assertFalse(document.is_symlink())
                front, _ = _split_frontmatter(document)
                self.assertRegex(front, rf"(?m)^name: {re.escape(skill)}$")
                # Rulesync renders descriptions as folded scalars; the source
                # keeps them single-line so projections normalize cleanly.
                self.assertNotRegex(front, r"(?m)^description:\s*>")
        # Live Codex reads the orchestration UI sidecar through the user-level link.
        self.assertTrue((SOURCE_ROOT / "orchestration" / "agents" / "openai.yaml").is_file())

    def test_only_the_canonical_source_is_tracked(self):
        tracked = subprocess.run(
            ["git", "ls-files", "--", ".github/skills", ".claude/skills", ".agents/skills"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        self.assertEqual([path for path in tracked if "/skills/" in f"/{path}"], [])
        ignored = [line.strip() for line in (REPO_ROOT / ".gitignore").read_text().splitlines()]
        self.assertIn("/.github/skills/", ignored)
        self.assertIn("/.claude/skills/", ignored)
        # Antigravity skips a gitignored `.agents/skills/`; the installer
        # excludes it through `.git/info/exclude` instead.
        self.assertEqual([line for line in ignored if ".agents/skills" in line and not line.startswith("#")], [])

    def test_each_tool_folder_receives_exactly_its_repository_skills_with_bundled_files(self):
        for folder, skills in REPOSITORY_SKILLS.items():
            root = self.generated / folder
            with self.subTest(folder=folder):
                self.assertEqual(tuple(sorted(path.name for path in root.iterdir())), skills)
                for skill in skills:
                    source = SOURCE_ROOT / skill
                    self.assertEqual(_files(root / skill), _files(source), msg=f"{folder}/{skill}")
                    for relative in _files(source):
                        if relative.name != "SKILL.md":
                            self.assertEqual((root / skill / relative).read_bytes(), (source / relative).read_bytes())
        self.assertEqual(
            sorted(path.relative_to(self.generated).as_posix() for path in self.generated.glob(".*/skills")),
            sorted(REPOSITORY_SKILLS),
        )

    def test_repository_folders_never_duplicate_user_level_skills(self):
        installer = INSTALLER.read_text()
        user_level = set(re.search(r"^skill_names=\(([^)]*)\)", installer, re.MULTILINE).group(1).split())
        for folder in (".claude/skills", ".agents/skills"):
            with self.subTest(folder=folder):
                projected = {path.name for path in (self.generated / folder).iterdir()}
                self.assertEqual(projected & user_level, set())

    def test_generated_documents_keep_name_description_and_body_without_targets(self):
        for folder, skills in REPOSITORY_SKILLS.items():
            for skill in skills:
                with self.subTest(folder=folder, skill=skill):
                    source_front, source_body = _split_frontmatter(SOURCE_ROOT / skill / "SKILL.md")
                    front, body = _split_frontmatter(self.generated / folder / skill / "SKILL.md")
                    self.assertRegex(front, rf"(?m)^name: {re.escape(skill)}$")
                    self.assertEqual(_description(front), _description(source_front))
                    self.assertNotRegex(front, r"(?m)^targets:")
                    self.assertEqual(body, source_body)

    def test_check_detects_edited_stale_and_missing_generated_skills(self):
        self.assertEqual(_rulesync(self.generated, "--check").returncode, 0)
        with tempfile.TemporaryDirectory() as temp:
            for label, damage in (
                ("edited", lambda root: (root / ".github/skills/ccc/SKILL.md").write_text("drift\n")),
                ("stale", lambda root: (root / ".github/skills/stale").mkdir() or (root / ".github/skills/stale/SKILL.md").write_text("x\n")),
                ("missing", lambda root: (root / ".claude/skills/autodev-codex-request-capture/SKILL.md").unlink()),
            ):
                with self.subTest(damage=label):
                    root = Path(temp) / label
                    self.assertEqual(_rulesync(root).returncode, 0)
                    damage(root)
                    self.assertNotEqual(_rulesync(root, "--check").returncode, 0)

    def test_installer_generates_and_checks_repository_skills(self):
        installer = INSTALLER.read_text()
        self.assertIn('rulesync_bin="$repo_root/node_modules/.bin/rulesync"', installer)
        self.assertIn('repository_skill_exclude_entry="/.agents/skills/"', installer)
        generation = installer.split("run_repository_outputs_generation() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn('(cd -- "$repo_root" && "$rulesync_bin" generate --config "$repo_root/rulesync.jsonc" "$@" --silent)', generation)
        self.assertRegex(
            installer,
            r"\nrender_claude_skill_views\nif ! render_bridge_mcp_catalogue >/dev/null; then\n  exit 1\nfi\nif ! generate_repository_outputs; then\n  exit 1\nfi\n",
        )
        check_links = installer.split("check_links() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("check_repository_outputs", check_links)

    def test_copilot_cloud_agent_generates_its_skills_during_setup(self):
        workflow = COPILOT_SETUP_WORKFLOW.read_text()
        install = workflow.index("pnpm install --frozen-lockfile")
        generate = workflow.index("pnpm exec rulesync generate --targets copilot --silent")
        self.assertLess(install, generate)
        self.assertIn('- ".rulesync/**"', workflow)

    def test_config_generates_only_repository_skills_and_ci_runs_every_rulesync_suite(self):
        # rulesync.jsonc is the only Rulesync configuration and drives the one
        # live projection; MCP, rules, and hooks projections are generated only
        # into temporary roots by their suites, never tracked as fixtures.
        config = json.loads(RULESYNC_CONFIG.read_text())
        self.assertEqual(tuple(config["targets"]), TARGETS)
        self.assertEqual(config["features"], ["skills", "hooks"])
        self.assertEqual(config["outputRoots"], ["."])
        self.assertIs(config["delete"], True)
        self.assertIs(config["global"], False)
        workflow = DRIFT_WORKFLOW.read_text()
        self.assertIn("run: python3 -m unittest tests/test_rulesync_*.py", workflow)
        self.assertEqual(workflow.count('- "tests/test_rulesync_*.py"'), 2)
        self.assertNotIn("rulesync generate", workflow)
        self.assertFalse(list(REPO_ROOT.glob("tests/fixtures/rulesync-*")))


if __name__ == "__main__":
    unittest.main()
