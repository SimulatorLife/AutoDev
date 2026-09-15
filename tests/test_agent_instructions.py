import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
AGENTS = REPO_ROOT / "AGENTS.md"


class AgentInstructionsTests(unittest.TestCase):
    """`AGENTS.md` is the only source of repository agent instructions. Codex,
    Antigravity, and Copilot (cloud agent, code review, CLI, VS Code chat) read it
    natively; Claude Code reads `CLAUDE.md`, a symlink to it."""

    def test_agents_md_is_the_single_regular_instruction_file(self):
        self.assertTrue(AGENTS.is_file())
        self.assertFalse(AGENTS.is_symlink())
        self.assertTrue(AGENTS.read_text().strip())

    def test_claude_md_is_a_symlink_to_agents_md(self):
        claude = REPO_ROOT / "CLAUDE.md"
        self.assertTrue(claude.is_symlink())
        self.assertEqual(claude.readlink(), Path("AGENTS.md"))

    def test_no_other_instruction_copies_exist(self):
        for relative in (".github/copilot-instructions.md", ".claude/CLAUDE.md", "GEMINI.md", ".rulesync/rules"):
            with self.subTest(path=relative):
                self.assertFalse((REPO_ROOT / relative).exists())
        tracked = subprocess.run(
            ["git", "ls-files", "-z"], cwd=REPO_ROOT, capture_output=True, check=True
        ).stdout.decode().split("\0")
        expected = AGENTS.read_bytes()
        copies = [
            path
            for path in tracked
            if path
            and path != "AGENTS.md"
            and (REPO_ROOT / path).is_file()
            and not (REPO_ROOT / path).is_symlink()
            and (REPO_ROOT / path).read_bytes() == expected
        ]
        self.assertEqual(copies, [])


if __name__ == "__main__":
    unittest.main()
