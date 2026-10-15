"""Pure checkout quote calculation."""

import pricing
import stock as stock_checks


def quote(price, quantity, stock):
    """Return the total cost and remaining stock for a valid purchase.

    Input validation is provided by the pricing and stock modules. A
    ``ValueError`` is raised when the inputs are invalid or when there is not
    enough stock to satisfy the requested quantity.
    """
    total = pricing.total(price, quantity)
    if not stock_checks.available(stock, quantity):
        raise ValueError("insufficient stock")

    return {"total_cents": total, "remaining_stock": stock - quantity}
