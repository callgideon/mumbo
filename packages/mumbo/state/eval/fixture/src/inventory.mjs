/** Inventory helpers; every one still returns a placeholder instead of its result. */

/**
 * Parse a stock quantity: a whole number of zero or more, surrounding spaces allowed.
 * @param {string} _text - the quantity as written in the stock file.
 * @returns {number} the quantity.
 * @throws {Error} when the text is not a whole number of zero or more.
 */
export function parseQuantity(_text) {
  return Number.NaN
}

/**
 * Read the stock file: a `name,quantity` header, then one item per line; blank lines are skipped.
 * @param {string} _csv - the file's text.
 * @returns {{ name: string, quantity: number }[]} the items in file order.
 */
export function parseStock(_csv) {
  return []
}

/**
 * Name the items to restock.
 * @param {{ name: string, quantity: number }[]} _items - the stock.
 * @param {number} [_threshold] - restock below this quantity; 5 when absent.
 * @returns {string[]} the names of the items below the threshold, sorted.
 */
export function restockList(_items, _threshold = 5) {
  return []
}
