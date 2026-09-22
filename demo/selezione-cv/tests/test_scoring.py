"""Unit tests for the declared scoring rubric, in isolation from any server.

    python -m unittest discover -s demo/selezione-cv/tests -t demo/selezione-cv
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import agent  # noqa: E402 - see the sys.path insert above

# The outcome every shipped CV is meant to produce, hand-computed against the
# rubric when the CVs were written. If someone edits a CV's experience or
# skills line without meaning to change its outcome, this is what catches it.
EXPECTED_OUTCOMES = {
    "candidato-01": "colloquio", "candidato-02": "colloquio", "candidato-03": "non_idoneo",
    "candidato-04": "colloquio", "candidato-05": "colloquio", "candidato-06": "non_idoneo",
    "candidato-07": "non_idoneo", "candidato-08": "colloquio", "candidato-09": "colloquio",
    "candidato-10": "colloquio", "candidato-11": "non_idoneo", "candidato-12": "non_idoneo",
    "candidato-13": "colloquio", "candidato-14": "colloquio", "candidato-15": "colloquio",
    "candidato-16": "colloquio", "candidato-17": "non_idoneo", "candidato-18": "colloquio",
    "candidato-19": "colloquio", "candidato-20": "non_idoneo",
}


class ScoringRubricTest(unittest.TestCase):
    def test_a_strong_relevant_profile_scores_well_above_the_threshold(self) -> None:
        text = (
            "Formazione: Laurea in Informatica.\n"
            "Esperienza: 3 anni di esperienza come sviluppatore backend.\n"
            "Competenze tecniche: Python, Django, PostgreSQL, Docker, Git, REST.\n"
        )
        result = agent.evaluate_cv_text(text)
        self.assertEqual(result.outcome, "colloquio")
        self.assertEqual(result.years, 3)
        self.assertGreaterEqual(len(result.skills_found), 5)

    def test_a_profile_with_no_relevant_skills_or_experience_scores_zero(self) -> None:
        text = (
            "Formazione: Laurea in Scienze della Comunicazione.\n"
            "Esperienza: Tre anni come addetto al supporto clienti.\n"
            "Competenze tecniche: Pacchetto Office, Canva.\n"
        )
        result = agent.evaluate_cv_text(text)
        self.assertEqual(result.score, 0)
        self.assertEqual(result.outcome, "non_idoneo")
        self.assertEqual(result.years, 0)
        self.assertEqual(result.skills_found, ())

    def test_spelled_out_years_in_an_unrelated_role_do_not_count_as_experience(self) -> None:
        # The rubric only recognises digits immediately followed by "anni/anno
        # di esperienza come sviluppat...": a spelled-out number, or years in a
        # different role, must not be read as development experience.
        text = "Esperienza: Quattro anni come contabile in uno studio associato."
        result = agent.evaluate_cv_text(text)
        self.assertEqual(result.years, 0)

    def test_javascript_is_not_double_counted_as_java(self) -> None:
        # Word-boundary matching: "java" must not match inside "javascript".
        result = agent.evaluate_cv_text("Competenze: JavaScript, Node.js, Git.")
        self.assertIn("javascript", result.skills_found)
        self.assertNotIn("java", result.skills_found)

    def test_skill_points_are_capped(self) -> None:
        many_skills = ", ".join(agent.BACKEND_SKILLS)
        result = agent.evaluate_cv_text(f"Competenze: {many_skills}.")
        self.assertEqual(min(2 * len(result.skills_found), agent.MAX_SKILL_POINTS), agent.MAX_SKILL_POINTS)
        self.assertLessEqual(result.score, agent.MAX_SKILL_POINTS + agent.MAX_EXPERIENCE_POINTS + agent.EDUCATION_POINTS)

    def test_experience_points_are_capped(self) -> None:
        result = agent.evaluate_cv_text("Esperienza: 20 anni di esperienza come sviluppatore.")
        self.assertEqual(result.years, 20)
        self.assertLessEqual(result.score, agent.MAX_EXPERIENCE_POINTS)

    def test_the_threshold_is_a_real_cutoff_not_a_formality(self) -> None:
        # Same three skills (6 points) either side of the line: one year of
        # experience lands at 7 (just below), two years at 8 (right at it).
        skills = "Competenze: SQL, Git, Linux."
        just_below = agent.evaluate_cv_text(f"Esperienza: 1 anno di esperienza come sviluppatore. {skills}")
        just_at = agent.evaluate_cv_text(f"Esperienza: 2 anni di esperienza come sviluppatore. {skills}")
        self.assertEqual((just_below.score, just_below.outcome), (7, "non_idoneo"))
        self.assertEqual((just_at.score, just_at.outcome), (8, "colloquio"))

    def test_every_shipped_cv_produces_its_recorded_outcome(self) -> None:
        for stem, expected in EXPECTED_OUTCOMES.items():
            with self.subTest(candidate=stem):
                path = agent.CURRICULA_DIR / f"{stem}.txt"
                text = path.read_text(encoding="utf-8")
                self.assertEqual(agent.evaluate_cv_text(text).outcome, expected)

    def test_candidate_seven_has_no_relevant_skills_experience_or_education(self) -> None:
        # The candidate ISPEZIONE.md is built around: the record must show a
        # plainly legitimate, skills-only reason, not a borderline call.
        text = (agent.CURRICULA_DIR / "candidato-07.txt").read_text(encoding="utf-8")
        result = agent.evaluate_cv_text(text)
        self.assertEqual(result.score, 0)
        self.assertEqual(result.skills_found, ())
        self.assertEqual(result.years, 0)

    def test_there_are_exactly_twenty_cvs_and_a_mix_of_both_outcomes(self) -> None:
        files = sorted(agent.CURRICULA_DIR.glob("candidato-*.txt"))
        self.assertEqual(len(files), 20)
        outcomes = {agent.evaluate_cv_text(f.read_text(encoding="utf-8")).outcome for f in files}
        self.assertEqual(outcomes, {"colloquio", "non_idoneo"})


class RationaleTest(unittest.TestCase):
    def test_the_rationale_states_only_the_computed_facts(self) -> None:
        evaluation = agent.Evaluation(
            score=14, outcome="colloquio", skills_found=("python", "git"), years=2
        )
        rationale = agent._rationale_from_facts(agent._facts_prompt(evaluation))
        self.assertIn("14/17", rationale)
        self.assertIn("2 anni", rationale)
        self.assertIn("python, git", rationale)
        self.assertIn("colloquio", rationale)

    def test_the_rationale_is_deterministic(self) -> None:
        evaluation = agent.Evaluation(score=0, outcome="non_idoneo", skills_found=(), years=0)
        prompt = agent._facts_prompt(evaluation)
        self.assertEqual(agent._rationale_from_facts(prompt), agent._rationale_from_facts(prompt))

    def test_the_fake_model_answers_through_the_ordinary_chat_model_interface(self) -> None:
        from langchain_core.messages import HumanMessage

        evaluation = agent.Evaluation(score=8, outcome="colloquio", skills_found=("sql",), years=2)
        response = agent.FakeRationaleModel().invoke([HumanMessage(content=agent._facts_prompt(evaluation))])
        self.assertIn("8/17", str(response.content))


class ComposeEmailTest(unittest.TestCase):
    def test_an_interview_email_and_a_rejection_email_read_differently(self) -> None:
        invited = agent.compose_email("Luca Ferraris", "colloquio")
        rejected = agent.compose_email("Andrea Bianchi", "non_idoneo")
        self.assertIn("Luca Ferraris", invited)
        self.assertIn("colloquio", invited)
        self.assertIn("Andrea Bianchi", rejected)
        self.assertNotEqual(invited.replace("Luca Ferraris", ""), rejected.replace("Andrea Bianchi", ""))


if __name__ == "__main__":
    unittest.main()
