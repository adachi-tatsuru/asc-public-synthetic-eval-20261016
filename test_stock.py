import unittest

from stock import available


class AvailableTests(unittest.TestCase):
    def test_returns_true_when_stock_equals_quantity(self):
        self.assertTrue(available(3, 3))

    def test_returns_true_when_stock_exceeds_quantity(self):
        self.assertTrue(available(4, 3))

    def test_returns_false_when_stock_is_insufficient(self):
        self.assertFalse(available(2, 3))

    def test_zero_stock_is_valid_but_unavailable(self):
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
