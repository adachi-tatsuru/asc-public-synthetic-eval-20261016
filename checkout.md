# Checkout quote

`checkout.quote(price, quantity, stock)` calculates a checkout quote without
performing I/O or changing stock.

- `price` is the unit price in integer cents and must be nonnegative.
- `quantity` is the number of items and must be a positive integer.
- `stock` is the available item count and must be a nonnegative integer.
- Booleans are invalid for all three inputs, despite being integer subclasses
  in Python.

For a valid request with sufficient stock, the function returns exactly:

```python
{"total_cents": price * quantity, "remaining_stock": stock - quantity}
```

It raises `ValueError` for an invalid input or when `stock` is less than
`quantity`. The calculation is pure: it has no persistence, network access,
I/O, or mutation.
