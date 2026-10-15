"""Pure checkout quote calculation."""

import pricing
import stock as stock_rules


def quote(price: int, quantity: int, stock: int) -> dict[str, int]:
    """Return the total cost and remaining stock for a checkout.

    Inputs follow the validation rules enforced by :func:`pricing.total` and
    :func:`stock.available`. A valid request that exceeds the available stock
    raises :class:`ValueError`.
    """
    total_cents = pricing.total(price, quantity)

    if not stock_rules.available(stock, quantity):
        raise ValueError("insufficient stock")

    return {
        "total_cents": total_cents,
        "remaining_stock": stock - quantity,
    }
