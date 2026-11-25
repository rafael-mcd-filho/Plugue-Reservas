// The established customer-change scenarios run unchanged before the new
// multi-table migrations and end-to-end scenarios. No remote database is used.
process.argv.push('--auto-table-combinations');
await import('./run_public_reservation_changes_regression.mjs');
