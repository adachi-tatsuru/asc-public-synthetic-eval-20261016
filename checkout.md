# Checkout quote

`checkout.quote(price, quantity, stock)` computes a synthetic checkout
quote using integer cents.

- `price`: a nonnegative integer unit price in cents
- `quantity`: a positive integer
- `stock`: a nonnegative integer number of items available

Booleans are not accepted as integers. Invalid values and requests with
insufficient stock raise `ValueError`.

For a valid request, the function returns exactly:

```python
{"total_cents": price * quantity, "remaining_stock": stock - quantity}
```

The calculation is pure: it performs no I/O, persists nothing, and does not
mutate stock or any input.
