def available(stock, quantity):
    """Return whether *stock* can satisfy *quantity*.

    Stock must be a nonnegative integer and quantity must be a positive
    integer. Booleans are rejected explicitly because they are integer
    subclasses in Python.
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
