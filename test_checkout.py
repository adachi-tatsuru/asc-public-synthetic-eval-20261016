"""Tests for the integrated checkout quote calculation."""

import unittest

import checkout


class QuoteTests(unittest.TestCase):
    def test_returns_total_and_remaining_stock(self):
        self.assertEqual(
            checkout.quote(250, 3, 10),
            {"total_cents": 750, "remaining_stock": 7},
        )

    def test_accepts_zero_price_and_exact_stock(self):
        self.assertEqual(
            checkout.quote(0, 2, 2),
            {"total_cents": 0, "remaining_stock": 0},
        )

    def test_rejects_insufficient_stock(self):
        with self.assertRaises(ValueError):
            checkout.quote(250, 4, 3)

    def test_rejects_invalid_price(self):
        for price in (-1, 1.5, "100", True):
            with self.subTest(price=price):
                with self.assertRaises(ValueError):
                    checkout.quote(price, 1, 1)

    def test_rejects_invalid_quantity(self):
        for quantity in (0, -1, 1.5, "1", True):
            with self.subTest(quantity=quantity):
                with self.assertRaises(ValueError):
                    checkout.quote(100, quantity, 1)

    def test_rejects_invalid_stock(self):
        for stock in (-1, 1.5, "1", True):
            with self.subTest(stock=stock):
                with self.assertRaises(ValueError):
                    checkout.quote(100, 1, stock)


if __name__ == "__main__":
    unittest.main()
