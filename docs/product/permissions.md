# Roles and permissions (generated)

Generated from `SYSTEM_ROLES` / `PERMISSIONS` in `packages/domain/src/security/permissions.ts` for version 1.0.0-rc.1. ⚠ marks a sensitive permission.

**Enforcement:** the menus only mirror these permissions for convenience. Every command is authorized again in the backend dispatcher and inside the services (`requirePermission`) before any transaction. Row-level scoping and field redaction are applied on the server:
- Without `booking.view_all` a user sees only ticket records they created or sell (others read as *not found*).
- Cost, profit and supplier balances are removed from responses without `booking.view_cost`, `booking.view_profit` or `supplier.view_financial`.
- Passport/national-ID data needs `customer.view_identity`.

**Permissions not used by any command yet:** `booking.void` (a void is recorded as a cancellation request of type VOID, which uses `refund.request` / `refund.manage`) and `template.manage` (no editable message/print templates yet). `settings.system` currently controls only the automatic-backup schedule.

| Permission | ADMIN | MANAGER | ACCOUNTANT | SALES_AGENT |
|---|:-:|:-:|:-:|:-:|
| `company.view` | ✔ | ✔ | ✔ | ✔ |
| `company.edit` ⚠ | ✔ | — | — | — |
| `company.branding` ⚠ | ✔ | — | — | — |
| `company.financial_config` ⚠ | ✔ | — | — | — |
| `customer.view` | ✔ | ✔ | ✔ | ✔ |
| `customer.create` | ✔ | ✔ | — | ✔ |
| `customer.edit` | ✔ | ✔ | — | ✔ |
| `customer.archive` | ✔ | ✔ | — | — |
| `customer.view_identity` ⚠ | ✔ | ✔ | — | ✔ |
| `booking.view` | ✔ | ✔ | ✔ | ✔ |
| `booking.view_all` | ✔ | ✔ | ✔ | — |
| `booking.create` | ✔ | ✔ | — | ✔ |
| `booking.edit` | ✔ | ✔ | — | ✔ |
| `booking.reserve` | ✔ | ✔ | — | ✔ |
| `booking.issue` | ✔ | ✔ | — | ✔ |
| `booking.discard` | ✔ | ✔ | — | ✔ |
| `booking.enter_cost` ⚠ | ✔ | ✔ | ✔ | ✔ |
| `booking.view_cost` ⚠ | ✔ | ✔ | ✔ | — |
| `booking.view_profit` ⚠ | ✔ | ✔ | ✔ | — |
| `booking.adjust_price` ⚠ | ✔ | ✔ | — | — |
| `booking.change_supplier` ⚠ | ✔ | ✔ | — | — |
| `booking.sell_below_cost` ⚠ | ✔ | ✔ | — | — |
| `booking.zero_price` ⚠ | ✔ | ✔ | — | — |
| `booking.reissue` ⚠ | ✔ | ✔ | — | — |
| `booking.void` ⚠ | ✔ | ✔ | — | — |
| `schedule.change` | ✔ | ✔ | — | ✔ |
| `schedule.notify` | ✔ | ✔ | — | ✔ |
| `schedule.confirm` | ✔ | ✔ | — | ✔ |
| `payment.customer.receive` | ✔ | ✔ | ✔ | ✔ |
| `payment.customer.reverse` ⚠ | ✔ | ✔ | ✔ | — |
| `payment.customer.refund` ⚠ | ✔ | ✔ | ✔ | — |
| `payment.accept_overpayment` ⚠ | ✔ | ✔ | ✔ | — |
| `balance.apply` ⚠ | ✔ | ✔ | ✔ | — |
| `supplier.view` | ✔ | ✔ | ✔ | ✔ |
| `supplier.create` | ✔ | — | ✔ | — |
| `supplier.edit` | ✔ | — | ✔ | — |
| `supplier.archive` | ✔ | — | ✔ | — |
| `supplier.view_financial` ⚠ | ✔ | ✔ | ✔ | — |
| `payment.supplier.pay` ⚠ | ✔ | — | ✔ | — |
| `payment.supplier.reverse` ⚠ | ✔ | — | ✔ | — |
| `payment.supplier.record_refund` ⚠ | ✔ | — | ✔ | — |
| `refund.request` | ✔ | ✔ | ✔ | ✔ |
| `refund.manage` ⚠ | ✔ | ✔ | ✔ | — |
| `refund.customer_before_supplier` ⚠ | ✔ | ✔ | — | — |
| `expense.view` ⚠ | ✔ | ✔ | ✔ | — |
| `expense.create` ⚠ | ✔ | — | ✔ | — |
| `expense.reverse` ⚠ | ✔ | — | ✔ | — |
| `expense.category.manage` ⚠ | ✔ | — | ✔ | — |
| `treasury.view` ⚠ | ✔ | ✔ | ✔ | — |
| `treasury.transfer` ⚠ | ✔ | — | ✔ | — |
| `treasury.manage_accounts` ⚠ | ✔ | — | ✔ | — |
| `treasury.owner_movements` ⚠ | ✔ | — | — | — |
| `finance.backdate` ⚠ | ✔ | — | ✔ | — |
| `finance.lock_period` ⚠ | ✔ | — | ✔ | — |
| `finance.unlock_period` ⚠ | ✔ | — | — | — |
| `finance.opening_balances` ⚠ | ✔ | — | ✔ | — |
| `finance.exchange_rates` ⚠ | ✔ | — | ✔ | — |
| `finance.override_rate` ⚠ | ✔ | — | ✔ | — |
| `dashboard.operational` | ✔ | ✔ | ✔ | ✔ |
| `dashboard.financial` ⚠ | ✔ | ✔ | ✔ | — |
| `report.sales` | ✔ | ✔ | ✔ | ✔ |
| `report.purchases` ⚠ | ✔ | ✔ | ✔ | — |
| `report.profit` ⚠ | ✔ | ✔ | ✔ | — |
| `report.receivables` ⚠ | ✔ | ✔ | ✔ | — |
| `report.payables` ⚠ | ✔ | ✔ | ✔ | — |
| `report.supplier_performance` ⚠ | ✔ | ✔ | ✔ | — |
| `report.statements` | ✔ | ✔ | ✔ | ✔ |
| `report.expenses` ⚠ | ✔ | ✔ | ✔ | — |
| `report.refunds` ⚠ | ✔ | ✔ | ✔ | — |
| `report.schedule_changes` | ✔ | ✔ | ✔ | ✔ |
| `report.employee_activity` ⚠ | ✔ | ✔ | — | — |
| `report.export` ⚠ | ✔ | ✔ | ✔ | — |
| `airline.view` | ✔ | ✔ | ✔ | ✔ |
| `airline.create` | ✔ | ✔ | — | — |
| `airline.edit` | ✔ | ✔ | — | — |
| `airline.archive` | ✔ | ✔ | — | — |
| `airport.manage` | ✔ | ✔ | — | — |
| `template.manage` | ✔ | ✔ | — | — |
| `user.view` ⚠ | ✔ | ✔ | — | — |
| `user.create` ⚠ | ✔ | — | — | — |
| `user.edit` ⚠ | ✔ | — | — | — |
| `user.disable` ⚠ | ✔ | — | — | — |
| `user.reset_credentials` ⚠ | ✔ | — | — | — |
| `user.assign_roles` ⚠ | ✔ | — | — | — |
| `role.view` ⚠ | ✔ | ✔ | — | — |
| `role.create` ⚠ | ✔ | — | — | — |
| `role.edit` ⚠ | ✔ | — | — | — |
| `role.manage_permissions` ⚠ | ✔ | — | — | — |
| `settings.system` ⚠ | ✔ | — | — | — |
| `audit.view` ⚠ | ✔ | ✔ | — | — |
| `backup.create` ⚠ | ✔ | ✔ | ✔ | — |
| `backup.restore` ⚠ | ✔ | — | — | — |
| `integrity.run` ⚠ | ✔ | ✔ | ✔ | — |
