"""The English CVs score exactly as the Italian originals they translate.

The English demo (agent.py here) applies the same rubric as
demo/selezione-cv/agent.py to translated CVs; a translation that added or
lost a skill, a year of experience or a computing degree would change a
candidate's outcome between the two languages. This test is what rules that
out, CV by CV.
"""

import importlib.util
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent.parent
ITALIAN = HERE.parent / "selezione-cv"


def _load(path: pathlib.Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module  # dataclasses look their module up there
    spec.loader.exec_module(module)
    return module


english = _load(HERE / "agent.py", "cv_screening_agent")
italian = _load(ITALIAN / "agent.py", "selezione_cv_agent")

OUTCOMES = {"colloquio": "interview", "non_idoneo": "not_suitable"}


class ParityTest(unittest.TestCase):
    def test_every_cv_scores_as_its_italian_original(self) -> None:
        for number in range(1, 21):
            with self.subTest(candidate=number):
                it = italian.evaluate_cv_text((ITALIAN / "curricula" / f"candidato-{number:02d}.txt").read_text(encoding="utf-8"))
                en = english.evaluate_cv_text((HERE / "curricula" / f"candidate-{number:02d}.txt").read_text(encoding="utf-8"))
                self.assertEqual(en.score, it.score)
                self.assertEqual(en.years, it.years)
                self.assertEqual(en.skills_found, tuple("microservices" if s == "microservizi" else s for s in it.skills_found))
                self.assertEqual(en.outcome, OUTCOMES[it.outcome])

    def test_the_tools_are_named_in_english(self) -> None:
        self.assertEqual(
            [english.read_cv.name, english.evaluate_candidate.name, english.send_email.name],
            ["read_cv", "evaluate_candidate", "send_email"],
        )


if __name__ == "__main__":
    unittest.main()
