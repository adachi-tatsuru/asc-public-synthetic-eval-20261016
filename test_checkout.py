import unittest
from unittest.mock import patch

from checkout import quote


class QuoteTests(unittest.TestCase):
    def test_returns_total_and_remaining_stock(self):
        self.assertEqual(
            quote(125, 4, 10),
            {"total_cents": 500, "remaining_stock": 6},
        )

    def test_allows_exact_stock(self):
        self.assertEqual(
            quote(0, 3, 3),
            {"total_cents": 0, "remaining_stock": 0},
        )

    def test_rejects_insufficient_stock(self):
        with self.assertRaises(ValueError):
            quote(125, 4, 3)

    def test_rejects_invalid_price(self):
        for price in (-1, True, False, 1.5, "125", None):
            with self.subTest(price=price):
                with self.assertRaises(ValueError):
                    quote(price, 1, 1)

    def test_rejects_invalid_quantity(self):
        for quantity in (0, -1, True, False, 1.5, "1", None):
            with self.subTest(quantity=quantity):
                with self.assertRaises(ValueError):
                    quote(125, quantity, 1)

    def test_rejects_invalid_stock(self):
        for stock_value in (-1, True, False, 1.5, "1", None):
            with self.subTest(stock=stock_value):
                with self.assertRaises(ValueError):
                    quote(125, 1, stock_value)

    def test_accepts_documented_keyword_arguments(self):
        self.assertEqual(
            quote(price=125, quantity=2, stock=5),
            {"total_cents": 250, "remaining_stock": 3},
        )

    def test_composes_pricing_and_stock_checks(self):
        with (
            patch("checkout.pricing.total", return_value=600) as total,
            patch("checkout.stock_rules.available", return_value=True) as available,
        ):
            result = quote(200, 3, 8)

        total.assert_called_once_with(200, 3)
        available.assert_called_once_with(8, 3)
        self.assertEqual(
            result,
            {"total_cents": 600, "remaining_stock": 5},
        )


if __name__ == "__main__":
    unittest.main()
