// Runs the established real-PostgreSQL booking/payment fixture first, then the
// automatic-combination migration and its end-to-end scenarios. No remote I/O.
process.argv.push('--auto-table-combinations');
await import('./run_reservation_section_pricing_regression.mjs');
