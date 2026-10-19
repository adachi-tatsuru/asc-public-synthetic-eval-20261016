import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from greeting import greeting


def test_greeting_returns_hello():
    assert greeting() == "Hello"


if __name__ == "__main__":
    test_greeting_returns_hello()
    print("OK")
