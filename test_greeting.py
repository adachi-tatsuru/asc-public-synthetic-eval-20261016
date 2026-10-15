import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import unittest
from greeting import greeting

class GreetingTest(unittest.TestCase):
    def test_returns_string(self):
        self.assertIsInstance(greeting(), str)

if __name__ == "__main__":
    unittest.main()
