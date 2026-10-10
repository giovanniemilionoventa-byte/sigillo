"""Support assistant: answers the customers' questions of the day."""
import json
import pathlib

ANSWERS = {
    "refund": "Refunds are processed within 5 working days.",
    "delivery": "Standard delivery takes 2 to 4 working days.",
    "invoice": "Your invoice is attached to the order confirmation email.",
}


def answer(question: str) -> str:
    for word, reply in ANSWERS.items():
        if word in question.lower():
            return reply
    return "I have passed your question to a colleague."


questions = json.loads(pathlib.Path("questions.json").read_text())
out = pathlib.Path("replies")
out.mkdir(exist_ok=True)
for item in questions:
    reply = answer(item["text"])
    (out / f"{item['id']}.txt").write_text(reply)
    print(f"{item['id']}: {reply}")
print("Done")
