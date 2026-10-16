import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import unittest
from greeting import greeting

class GreetingTest(unittest.TestCase):
    def test_returns_string(self):
        self.assertIsInstance(greeting(), str)

    def test_returns_exact_greeting(self):
        result = greeting()
        self.assertEqual(result, "Hello")
        self.assertNotEqual(result, "Helo")

if __name__ == "__main__":
    unittest.main()
