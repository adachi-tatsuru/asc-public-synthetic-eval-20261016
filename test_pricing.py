import unittest

from pricing import total


class TotalTests(unittest.TestCase):
    def test_multiplies_price_by_quantity(self):
        self.assertEqual(total(250, 3), 750)

    def test_accepts_zero_price(self):
        self.assertEqual(total(0, 4), 0)

    def test_rejects_invalid_prices(self):
        for price in (-1, True, False, 1.5, "100", None):
            with self.subTest(price=price):
                with self.assertRaises(ValueError):
                    total(price, 1)

    def test_rejects_invalid_quantities(self):
        for quantity in (0, -1, True, False, 1.5, "2", None):
            with self.subTest(quantity=quantity):
                with self.assertRaises(ValueError):
                    total(100, quantity)


if __name__ == "__main__":
    unittest.main()
