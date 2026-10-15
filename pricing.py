"""Pure pricing calculations for the synthetic checkout."""


def total(price, quantity):
    """Return the total price in cents for ``quantity`` items.

    ``price`` must be a nonnegative integer and ``quantity`` must be a
    positive integer. Booleans are rejected even though ``bool`` subclasses
    ``int`` in Python.
    """
    if isinstance(price, bool) or not isinstance(price, int) or price < 0:
        raise ValueError("price must be a nonnegative integer")
    if (
        isinstance(quantity, bool)
        or not isinstance(quantity, int)
        or quantity <= 0
    ):
        raise ValueError("quantity must be a positive integer")

    return price * quantity
