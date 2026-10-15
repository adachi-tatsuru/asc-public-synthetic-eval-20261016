import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import unittest

from stock import available


class StockTest(unittest.TestCase):
    def test_returns_true_when_stock_is_sufficient(self):
        self.assertTrue(available(5, 3))

    def test_returns_true_when_stock_exactly_matches_quantity(self):
        self.assertTrue(available(3, 3))

    def test_returns_false_when_stock_is_insufficient(self):
        self.assertFalse(available(2, 3))

    def test_zero_stock_is_valid(self):
        self.assertFalse(available(0, 1))

    def test_rejects_invalid_stock(self):
        for stock in (-1, True, False, 1.0, "1", None):
            with self.subTest(stock=stock):
                with self.assertRaises(ValueError):
                    available(stock, 1)

    def test_rejects_invalid_quantity(self):
        for quantity in (0, -1, True, False, 1.0, "1", None):
            with self.subTest(quantity=quantity):
                with self.assertRaises(ValueError):
                    available(1, quantity)


if __name__ == "__main__":
    unittest.main()
