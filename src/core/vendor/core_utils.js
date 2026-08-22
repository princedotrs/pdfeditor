/* eslint-disable */
// @ts-nocheck
/**
 * VENDORED FROM pdf.js (Apache License 2.0) — do not edit by hand.
 * Regenerate with: node scripts/extract-pdfjs-tables.mjs
 */
export function getLookupTableFactory(initializer) {
  let lookup;
  return function () {
    if (initializer) {
      lookup = Object.create(null);
      initializer(lookup);
      initializer = null;
    }
    return lookup;
  };
}
