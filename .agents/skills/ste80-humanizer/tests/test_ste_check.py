"""Tests for scripts/ste_check.py: rule filtering, --max-findings, inline directives and --compare."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import ste_check  # noqa: E402


class TestSteCheckFilteringAndDirectives(unittest.TestCase):
    def test_backward_compatible_check_signature(self) -> None:
        bad = "It is important to note that the token is validated by the gateway.\n"
        findings = ste_check.check(bad, False)
        rules = {f.rule for f in findings}
        self.assertIn("word", rules)
        self.assertIn("passive", rules)

    def test_select_and_ignore_rules(self) -> None:
        text = "It is important to note that the token is validated by the gateway.\n"
        only_passive = ste_check.check(text, False, select={"passive"})
        self.assertTrue(only_passive)
        self.assertEqual({f.rule for f in only_passive}, {"passive"})

        no_passive = ste_check.check(text, False, ignore={"passive"})
        self.assertTrue(no_passive)
        self.assertNotIn("passive", {f.rule for f in no_passive})

        # --ignore applied after --select
        combined = ste_check.check(text, False, select={"passive", "word"}, ignore={"passive"})
        self.assertEqual({f.rule for f in combined}, {"word"})

    def test_disable_next_line_specific_and_all(self) -> None:
        text = (
            "<!-- ste-check-disable-next-line passive -->\n"
            "It is important to note that the token is validated by the gateway.\n"
            "The request is forwarded by the proxy.\n"
        )
        findings = ste_check.check(text, False)
        line2_rules = {f.rule for f in findings if f.line == 2}
        line3_rules = {f.rule for f in findings if f.line == 3}
        self.assertNotIn("passive", line2_rules)
        self.assertIn("word", line2_rules)
        self.assertIn("passive", line3_rules)

        all_suppressed = (
            "<!-- ste-check-disable-next-line -->\n"
            "It is important to note that the token is validated by the gateway.\n"
        )
        self.assertEqual(ste_check.check(all_suppressed, False), [])

    def test_disable_and_enable_block(self) -> None:
        text = (
            "<!-- ste-check-disable -->\n"
            "Great question! This seamless tool is validated by the gateway.\n"
            "<!-- ste-check-enable -->\n"
            "This seamless tool runs fast.\n"
        )
        findings = ste_check.check(text, False)
        self.assertEqual([(f.line, f.rule) for f in findings], [(4, "word")])

    def test_disable_block_specific_rule_and_partial_reenable(self) -> None:
        text = (
            "<!-- ste-check-disable passive, word -->\n"
            "The seamless token is validated by the gateway.\n"
            "<!-- ste-check-enable word -->\n"
            "The seamless token is validated by the gateway.\n"
            "<!-- ste-check-enable passive -->\n"
            "The token is validated by the gateway.\n"
        )
        findings = ste_check.check(text, False)
        self.assertEqual([(f.line, f.rule) for f in findings], [(4, "word"), (6, "passive")])

    def test_directives_ignored_in_code_fences_and_inline_code(self) -> None:
        text = (
            "```markdown\n"
            "<!-- ste-check-disable -->\n"
            "```\n"
            "The seamless token runs.\n"
            "Use `<!-- ste-check-disable -->` to skip a section.\n"
            "The robust token runs.\n"
        )
        findings = ste_check.check(text, False)
        self.assertEqual([(f.line, f.rule) for f in findings], [(4, "word"), (6, "word")])

    def test_unknown_rule_in_directive_is_reported(self) -> None:
        text = (
            "<!-- ste-check-disable -->\n"
            "The token is validated by the gateway.\n"
            "<!-- ste-check-enable passiv -->\n"
            "The token is validated by the gateway.\n"
        )
        findings = ste_check.check(text, False)
        self.assertEqual([(f.line, f.rule) for f in findings], [(3, "directive")])
        self.assertIn("passiv", findings[0].message)
        self.assertEqual(ste_check.check(text, False, ignore={"directive"}), [])

    def test_directive_comment_itself_does_not_trigger_dash_or_words(self) -> None:
        text = (
            "<!-- ste-check-disable-next-line passive -->\n"
            "The token is validated by the gateway.\n"
        )
        self.assertEqual(ste_check.check(text, False), [])
        stats = ste_check.summary(text)
        self.assertEqual(stats["sentences"], 1)

    def test_cli_list_rules_and_json(self) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ste_check.main(["--list-rules"])
        self.assertEqual(rc, 0)
        listed = buf.getvalue().strip().splitlines()
        self.assertEqual(set(listed), set(ste_check.ALL_RULES))

        buf_json = io.StringIO()
        with contextlib.redirect_stdout(buf_json):
            rc = ste_check.main(["--list-rules", "--json"])
        self.assertEqual(rc, 0)
        self.assertEqual(set(json.loads(buf_json.getvalue())), set(ste_check.ALL_RULES))

    def test_cli_max_findings_and_select_ignore(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "doc.md"
            sample.write_text("This seamless tool is validated by the gateway.\n", encoding="utf-8")

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_fail = ste_check.main([str(sample)])
            self.assertEqual(rc_fail, 1)

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_max = ste_check.main(["--max-findings", "2", str(sample)])
            self.assertEqual(rc_max, 0)

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_ignore = ste_check.main(["--ignore", "word", "--ignore", "passive", str(sample)])
            self.assertEqual(rc_ignore, 0)

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_select = ste_check.main(["--select", "semicolon", str(sample)])
            self.assertEqual(rc_select, 0)

    def test_cli_invalid_args_exit_2(self) -> None:
        for bad_argv in (
            ["--ignore", "not-a-real-rule", "-"],
            ["--select", "bogus", "-"],
            ["--max-findings", "-1", "-"],
            [],
        ):
            with self.assertRaises(SystemExit) as ctx:
                with contextlib.redirect_stderr(io.StringIO()):
                    ste_check.main(bad_argv)
            self.assertEqual(ctx.exception.code, 2, bad_argv)


class TestSteCheckCompareFidelity(unittest.TestCase):
    def test_faithful_ste_rewrite_passes(self) -> None:
        original = (
            "Great question! Kubernetes liveness probes might fail when `initialDelaySeconds` "
            "or `failureThreshold` is too low for 40+ services. See https://kubernetes.io/docs/tasks/.\n"
        )
        rewrite = (
            "A liveness probe can fail if `initialDelaySeconds` or `failureThreshold` "
            "is too low for 40+ services. Read the [docs](https://kubernetes.io/docs/tasks/).\n"
        )
        self.assertEqual(ste_check.compare_texts(original, rewrite), [])

    def test_catches_altered_quantifier_number(self) -> None:
        original = "We serve 40+ customers with 99.9% uptime.\n"
        rewrite = "We serve 40-odd customers with 99% uptime.\n"
        findings = ste_check.compare_texts(original, rewrite)
        self.assertEqual([f.rule for f in findings], ["fidelity-number", "fidelity-number"])
        self.assertIn("40+", findings[0].message)
        self.assertIn("99.9%", findings[1].message)

    def test_catches_missing_inline_and_fenced_code(self) -> None:
        original = (
            "Set `initialDelaySeconds` and `failureThreshold`.\n"
            "```bash\n"
            "kubectl apply -f probe.yaml\n"
            "```\n"
        )
        rewrite = (
            "Set `initialDelaySeconds`.\n"
            "```bash\n"
            "kubectl apply -f deploy.yaml\n"
            "```\n"
        )
        findings = ste_check.compare_texts(original, rewrite)
        self.assertEqual([f.rule for f in findings], ["fidelity-code", "fidelity-code"])
        self.assertIn("failureThreshold", findings[0].message)
        self.assertIn("fenced code block", findings[1].message)

    def test_catches_missing_url(self) -> None:
        original = "Read the [guide](https://example.com/guide) and https://example.com/api.\n"
        rewrite = "Read the [guide](https://example.com/guide).\n"
        findings = ste_check.compare_texts(original, rewrite)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule, "fidelity-url")
        self.assertIn("https://example.com/api", findings[0].message)

    def test_catches_dropped_quote(self) -> None:
        original = 'The note says "written in STE style" on the cover.\n'
        rewrite = "The note describes the style on the cover.\n"
        findings = ste_check.compare_texts(original, rewrite)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0].rule, "fidelity-quote")

    def test_curly_to_straight_quote_normalization_passes(self) -> None:
        original = "The label reads “written in STE style”.\n"
        rewrite = 'The label reads "written in STE style".\n'
        self.assertEqual(ste_check.compare_texts(original, rewrite), [])

    def test_catches_dropped_uncertainty_hedge(self) -> None:
        original = "This change might fail on empty headers.\n"
        rewrite = "This change fails on empty headers.\n"
        findings = ste_check.compare_texts(original, rewrite)
        self.assertEqual([f.rule for f in findings], ["fidelity-certainty"])

    def test_allows_ste_certainty_swap_might_to_can(self) -> None:
        original = "This change might fail on empty headers.\n"
        rewrite = "This change can fail on empty headers.\n"
        self.assertEqual(ste_check.compare_texts(original, rewrite), [])

    def test_list_renumbering_does_not_false_positive(self) -> None:
        original = "1. Open the file.\n2. Save the file.\n"
        rewrite = "- Open the file.\n- Save the file.\n"
        self.assertEqual(ste_check.compare_texts(original, rewrite), [])

    def test_cli_compare_text_and_json_and_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            orig = Path(tmp) / "orig.md"
            good = Path(tmp) / "good.md"
            bad = Path(tmp) / "bad.md"
            orig.write_text("It might handle 40+ items via `run_job`.\n", encoding="utf-8")
            good.write_text("It can handle 40+ items with `run_job`.\n", encoding="utf-8")
            bad.write_text("It handles 40 items.\n", encoding="utf-8")

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_ok = ste_check.main(["--compare", str(orig), str(good)])
            self.assertEqual(rc_ok, 0)

            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc_bad = ste_check.main(["--compare", str(orig), str(bad), "--json"])
            self.assertEqual(rc_bad, 1)
            data = json.loads(buf.getvalue())
            rules = {f["rule"] for f in data["findings"]}
            self.assertEqual(rules, {"fidelity-number", "fidelity-code", "fidelity-certainty"})

            for bad_argv in (
                ["--compare", "-", "-"],
                ["--compare", str(orig), str(good), str(bad)],
                [],
            ):
                with self.assertRaises(SystemExit) as ctx:
                    with contextlib.redirect_stderr(io.StringIO()):
                        ste_check.main(bad_argv)
                self.assertEqual(ctx.exception.code, 2, bad_argv)


    def test_catches_changed_number_with_unit(self) -> None:
        original = "Set the timeout to 30s and the delay to 100ms on 8GB hosts.\n"
        rewrite = "Set the timeout to 60s and the delay to 100ms on 4GB hosts.\n"
        findings = ste_check.compare_texts(original, rewrite)
        self.assertEqual([f.rule for f in findings], ["fidelity-number", "fidelity-number"])
        self.assertIn("30s", findings[0].message)
        self.assertIn("8gb", findings[1].message)

    def test_catches_dropped_cli_flag_in_prose(self) -> None:
        original = "Run the checker with --json to get a report.\n"
        self.assertEqual([f.rule for f in ste_check.compare_texts(original, "Run the checker to get a report.\n")], ["fidelity-code"])
        self.assertEqual(ste_check.compare_texts(original, "Use `--json` to get a report.\n"), [])

    def test_cli_compare_filters_and_unreadable_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            orig = Path(tmp) / "orig.md"
            bad = Path(tmp) / "bad.md"
            orig.write_text("It might handle 40+ items.\n", encoding="utf-8")
            bad.write_text("It handles 40 items.\n", encoding="utf-8")

            for argv, expected in (
                (["--compare", str(orig), str(bad)], 1),
                (["--compare", str(orig), str(bad), "--ignore", "fidelity-number,fidelity-certainty"], 0),
                (["--compare", str(orig), str(bad), "--max-findings", "2"], 0),
            ):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(ste_check.main(argv), expected, argv)

            for argv in (["--compare", str(orig), str(Path(tmp) / "missing.md")], [str(Path(tmp) / "missing.md")]):
                with self.assertRaises(SystemExit) as ctx:
                    with contextlib.redirect_stderr(io.StringIO()):
                        ste_check.main(argv)
                self.assertEqual(ctx.exception.code, 2, argv)


if __name__ == "__main__":
    unittest.main()
