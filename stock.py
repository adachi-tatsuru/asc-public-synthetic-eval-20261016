"""Stock availability checks for the synthetic checkout."""


def available(stock, quantity):
    """Return whether ``stock`` can satisfy ``quantity``.

    ``stock`` must be a nonnegative integer and ``quantity`` must be a
    positive integer. Booleans are rejected even though ``bool`` is an
    ``int`` subclass in Python.
    """
    if isinstance(stock, bool) or not isinstance(stock, int) or stock < 0:
        raise ValueError("stock must be a nonnegative integer")
    if (
        isinstance(quantity, bool)
        or not isinstance(quantity, int)
        or quantity <= 0
    ):
        raise ValueError("quantity must be a positive integer")

    return stock >= quantity
