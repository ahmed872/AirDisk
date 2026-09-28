import type { DocType } from '../ledger/documents';

/**
 * Permission catalogue (Phase 0 §06-5). Codes are stable identifiers stored in
 * the database; roles are data and can be customised per installation (Q5).
 * Frontend hiding is never authorization — the backend checks these.
 */
export interface PermissionDefinition {
  readonly code: string;
  readonly module: string;
  readonly sensitive: boolean;
  readonly ar: string;
  readonly en: string;
}

const p = (code: string, sensitive: boolean, ar: string, en: string): PermissionDefinition => ({
  code,
  module: code.split('.')[0]!,
  sensitive,
  ar,
  en,
});

export const PERMISSIONS: readonly PermissionDefinition[] = [
  p('company.view', false, 'عرض بيانات الشركة', 'View company'),
  p('company.edit', true, 'تعديل بيانات الشركة', 'Edit company'),
  p('company.branding', true, 'إدارة الهوية والشعار', 'Manage branding'),
  p('company.financial_config', true, 'الإعدادات المالية والضريبية للشركة', 'Manage financial configuration'),

  p('customer.view', false, 'عرض العملاء', 'View customers'),
  p('customer.create', false, 'إضافة عملاء', 'Create customers'),
  p('customer.edit', false, 'تعديل العملاء', 'Edit customers'),
  p('customer.archive', false, 'أرشفة العملاء واستعادتهم', 'Archive customers'),
  p('customer.view_identity', true, 'عرض بيانات الهوية والجواز', 'View identity/passport data'),

  p('booking.view', false, 'عرض الحجوزات', 'View bookings'),
  p('booking.view_all', false, 'عرض حجوزات كل الموظفين', 'View all employees’ bookings'),
  p('booking.create', false, 'إنشاء حجوزات', 'Create bookings'),
  p('booking.edit', false, 'تعديل الحجوزات', 'Edit bookings'),
  p('booking.reserve', false, 'حجز مبدئي', 'Reserve bookings'),
  p('booking.issue', false, 'إصدار التذاكر', 'Issue tickets'),
  p('booking.discard', false, 'إلغاء المسودات', 'Discard drafts'),
  p('booking.enter_cost', true, 'إدخال تكلفة الشراء', 'Enter purchase cost'),
  p('booking.view_cost', true, 'عرض تكلفة الشراء', 'View purchase cost'),
  p('booking.view_profit', true, 'عرض الربح', 'View profit'),
  p('booking.adjust_price', true, 'تعديل السعر بعد الإصدار', 'Adjust price after issue'),
  p('booking.change_supplier', true, 'تغيير المورد بعد الإصدار', 'Change supplier after issue'),
  p('booking.sell_below_cost', true, 'البيع بأقل من التكلفة', 'Sell below cost'),
  p('booking.zero_price', true, 'تذاكر بسعر صفر', 'Zero-priced tickets'),
  p('booking.reissue', true, 'إعادة إصدار / تبديل', 'Reissue / exchange'),
  p('booking.void', true, 'إلغاء التذكرة (Void)', 'Void tickets'),

  p('schedule.change', false, 'تسجيل تغيير موعد الرحلة', 'Record schedule changes'),
  p('schedule.notify', false, 'إبلاغ العميل', 'Notify customers'),
  p('schedule.confirm', false, 'تأكيد إبلاغ العميل', 'Confirm notification'),

  p('payment.customer.receive', false, 'استلام دفعات العملاء', 'Receive customer payments'),
  p('payment.customer.reverse', true, 'عكس دفعات العملاء', 'Reverse customer payments'),
  p('payment.customer.refund', true, 'رد مبالغ للعملاء', 'Refund customers'),
  p('payment.accept_overpayment', true, 'قبول دفعات زائدة', 'Accept overpayments'),
  p('balance.apply', true, 'تسوية الأرصدة بين الحجوزات', 'Apply balances'),

  p('supplier.view', false, 'عرض الموردين', 'View suppliers'),
  p('supplier.create', false, 'إضافة موردين', 'Create suppliers'),
  p('supplier.edit', false, 'تعديل الموردين', 'Edit suppliers'),
  p('supplier.archive', false, 'أرشفة الموردين واستعادتهم', 'Archive suppliers'),
  p('supplier.view_financial', true, 'عرض البيانات المالية للموردين', 'View supplier financial information'),
  p('payment.supplier.pay', true, 'الدفع للموردين', 'Pay suppliers'),
  p('payment.supplier.reverse', true, 'عكس دفعات الموردين', 'Reverse supplier payments'),
  p('payment.supplier.record_refund', true, 'تسجيل استرداد من المورد', 'Record supplier refunds'),

  p('refund.request', false, 'طلب إلغاء / استرداد', 'Request cancellation/refund'),
  p('refund.manage', true, 'إدارة الاستردادات', 'Manage refunds'),
  p('refund.customer_before_supplier', true, 'الرد للعميل قبل تأكيد المورد', 'Refund customer before supplier confirms'),

  p('expense.view', true, 'عرض المصروفات', 'View expenses'),
  p('expense.create', true, 'تسجيل المصروفات', 'Record expenses'),
  p('expense.reverse', true, 'عكس المصروفات', 'Reverse expenses'),
  p('expense.category.manage', true, 'إدارة بنود المصروفات', 'Manage expense categories'),

  p('treasury.view', true, 'عرض الخزينة والبنوك', 'View treasury'),
  p('treasury.transfer', true, 'التحويل بين الحسابات', 'Transfer between accounts'),
  p('treasury.manage_accounts', true, 'إدارة حسابات الخزينة', 'Manage money accounts'),
  p('treasury.owner_movements', true, 'حركات المالك', 'Owner capital & drawings'),

  p('finance.backdate', true, 'التسجيل بتاريخ سابق', 'Backdate documents'),
  p('finance.lock_period', true, 'إقفال الفترات المالية', 'Lock financial periods'),
  p('finance.unlock_period', true, 'إعادة فتح فترة مقفلة', 'Unlock financial periods'),
  p('finance.opening_balances', true, 'الأرصدة الافتتاحية', 'Opening balances'),
  p('finance.exchange_rates', true, 'أسعار الصرف', 'Exchange rates'),
  p('finance.override_rate', true, 'تعديل سعر الصرف في المستند', 'Override document rate'),

  p('dashboard.operational', false, 'لوحة التشغيل', 'Operational dashboard'),
  p('dashboard.financial', true, 'اللوحة المالية', 'Financial dashboard'),

  p('report.sales', false, 'تقرير المبيعات', 'Sales report'),
  p('report.purchases', true, 'تقرير المشتريات', 'Purchases report'),
  p('report.profit', true, 'تقرير الأرباح', 'Profit report'),
  p('report.receivables', true, 'تقرير مستحقات العملاء', 'Receivables report'),
  p('report.payables', true, 'تقرير مستحقات الموردين', 'Payables report'),
  p('report.supplier_performance', true, 'أداء الموردين', 'Supplier performance'),
  p('report.statements', false, 'كشوف الحساب', 'Statements'),
  p('report.expenses', true, 'تقرير المصروفات', 'Expenses report'),
  p('report.refunds', true, 'تقرير الإلغاءات والاستردادات', 'Refunds report'),
  p('report.schedule_changes', false, 'تقرير تغييرات الرحلات', 'Schedule changes report'),
  p('report.employee_activity', true, 'نشاط الموظفين', 'Employee activity'),
  p('report.export', true, 'تصدير التقارير', 'Export reports'),

  p('airline.view', false, 'عرض شركات الطيران', 'View airlines'),
  p('airline.create', false, 'إضافة شركات طيران', 'Create airlines'),
  p('airline.edit', false, 'تعديل شركات الطيران', 'Edit airlines'),
  p('airline.archive', false, 'أرشفة شركات الطيران واستعادتها', 'Archive airlines'),
  p('airport.manage', false, 'إدارة المطارات', 'Manage airports'),
  p('template.manage', false, 'إدارة قوالب الرسائل', 'Manage message templates'),

  p('user.view', true, 'عرض المستخدمين', 'View users'),
  p('user.create', true, 'إضافة مستخدمين', 'Create users'),
  p('user.edit', true, 'تعديل المستخدمين', 'Edit users'),
  p('user.disable', true, 'إيقاف وتفعيل المستخدمين', 'Disable/enable users'),
  p('user.reset_credentials', true, 'إعادة تعيين كلمات المرور وفك القفل', 'Reset credentials'),
  p('user.assign_roles', true, 'إسناد الأدوار للمستخدمين', 'Assign roles to users'),
  p('role.view', true, 'عرض الأدوار', 'View roles'),
  p('role.create', true, 'إنشاء أدوار', 'Create roles'),
  p('role.edit', true, 'تعديل الأدوار', 'Edit roles'),
  p('role.manage_permissions', true, 'إدارة صلاحيات الأدوار', 'Manage role permissions'),
  p('settings.system', true, 'إعدادات النظام', 'System settings'),
  p('audit.view', true, 'سجل التدقيق', 'View audit log'),
  p('backup.create', true, 'إنشاء نسخة احتياطية', 'Create backups'),
  p('backup.restore', true, 'استعادة نسخة احتياطية', 'Restore backups'),
  p('integrity.run', true, 'فحص سلامة البيانات', 'Run integrity checks'),
];

export type PermissionCode = string;

export const ALL_PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSIONS.map((x) => x.code));

export function isKnownPermission(code: string): boolean {
  return ALL_PERMISSION_CODES.has(code);
}

/** System roles and their DEFAULT grants (Phase 0 §06-6, confirmed by Q5). Admins may edit them later. */
export const SYSTEM_ROLES: ReadonlyArray<{ code: string; nameAr: string; nameEn: string; permissions: readonly string[] | 'ALL' }> = [
  { code: 'ADMIN', nameAr: 'مدير النظام', nameEn: 'Administrator', permissions: 'ALL' },
  {
    code: 'MANAGER',
    nameAr: 'مدير',
    nameEn: 'Manager',
    permissions: [
      'company.view',
      'customer.view', 'customer.create', 'customer.edit', 'customer.archive', 'customer.view_identity',
      'booking.view', 'booking.view_all', 'booking.create', 'booking.edit', 'booking.reserve', 'booking.issue', 'booking.discard',
      'booking.enter_cost', 'booking.view_cost', 'booking.view_profit', 'booking.adjust_price', 'booking.change_supplier',
      'booking.sell_below_cost', 'booking.zero_price', 'booking.reissue', 'booking.void',
      'schedule.change', 'schedule.notify', 'schedule.confirm',
      'payment.customer.receive', 'payment.customer.reverse', 'payment.customer.refund', 'payment.accept_overpayment', 'balance.apply',
      'supplier.view', 'supplier.view_financial',
      'refund.request', 'refund.manage', 'refund.customer_before_supplier',
      'expense.view', 'treasury.view',
      'dashboard.operational', 'dashboard.financial',
      'report.sales', 'report.purchases', 'report.profit', 'report.receivables', 'report.payables', 'report.supplier_performance',
      'report.statements', 'report.expenses', 'report.refunds', 'report.schedule_changes', 'report.employee_activity', 'report.export',
      'airline.view', 'airline.create', 'airline.edit', 'airline.archive', 'airport.manage', 'template.manage',
      'user.view', 'role.view',
      'audit.view', 'backup.create', 'integrity.run',
    ],
  },
  {
    code: 'ACCOUNTANT',
    nameAr: 'محاسب',
    nameEn: 'Accountant',
    permissions: [
      'company.view', 'customer.view', 'airline.view',
      'booking.view', 'booking.view_all', 'booking.enter_cost', 'booking.view_cost', 'booking.view_profit',
      'payment.customer.receive', 'payment.customer.reverse', 'payment.customer.refund', 'payment.accept_overpayment', 'balance.apply',
      'supplier.view', 'supplier.create', 'supplier.edit', 'supplier.archive', 'supplier.view_financial',
      'payment.supplier.pay', 'payment.supplier.reverse', 'payment.supplier.record_refund',
      'refund.request', 'refund.manage',
      'expense.view', 'expense.create', 'expense.reverse', 'expense.category.manage',
      'treasury.view', 'treasury.transfer', 'treasury.manage_accounts',
      'finance.backdate', 'finance.lock_period', 'finance.opening_balances', 'finance.exchange_rates', 'finance.override_rate',
      'dashboard.operational', 'dashboard.financial',
      'report.sales', 'report.purchases', 'report.profit', 'report.receivables', 'report.payables', 'report.supplier_performance',
      'report.statements', 'report.expenses', 'report.refunds', 'report.schedule_changes', 'report.export',
      'backup.create', 'integrity.run',
    ],
  },
  {
    code: 'SALES_AGENT',
    nameAr: 'موظف مبيعات',
    nameEn: 'Sales agent',
    permissions: [
      'company.view', 'customer.view', 'customer.create', 'customer.edit', 'customer.view_identity',
      'booking.view', 'booking.create', 'booking.edit', 'booking.reserve', 'booking.issue', 'booking.discard', 'booking.enter_cost',
      'schedule.change', 'schedule.notify', 'schedule.confirm',
      'payment.customer.receive',
      'supplier.view', 'airline.view',
      'refund.request',
      'dashboard.operational',
      'report.sales', 'report.statements', 'report.schedule_changes',
    ],
  },
];

/**
 * Permission codes replaced by finer-grained ones in a later version. On
 * upgrade the seeder grants the replacements to every role that held the old
 * code, then removes the old code — so no installation silently loses access.
 * Entries are never removed from this map.
 */
export const PERMISSION_RENAMES: Readonly<Record<string, readonly string[]>> = {
  'customer.deactivate': ['customer.archive'],
  'supplier.manage': ['supplier.create', 'supplier.edit', 'supplier.archive'],
  'supplier.view_balance': ['supplier.view_financial'],
  'airline.manage': ['airline.view', 'airline.create', 'airline.edit', 'airline.archive'],
  'user.manage': ['user.view', 'user.create', 'user.edit', 'user.disable', 'user.reset_credentials', 'user.assign_roles'],
  'role.manage': ['role.view', 'role.create', 'role.edit', 'role.manage_permissions'],
  'settings.company': ['company.edit', 'company.branding', 'company.financial_config'],
};

export function defaultPermissionsForRole(roleCode: string): readonly string[] {
  const role = SYSTEM_ROLES.find((r) => r.code === roleCode);
  if (!role) return [];
  return role.permissions === 'ALL' ? [...ALL_PERMISSION_CODES] : role.permissions;
}

/**
 * Minimum permission needed to post (any of) / reverse a document type. Business
 * commands in later phases check their own, stricter permission first; the
 * posting service re-checks this as defence in depth.
 */
export const DOCUMENT_POST_PERMISSIONS: Readonly<Record<DocType, readonly string[]>> = {
  CUSTOMER_INVOICE: ['booking.issue', 'booking.adjust_price', 'booking.reissue', 'refund.manage'],
  CUSTOMER_CREDIT_NOTE: ['booking.adjust_price', 'booking.void', 'refund.manage'],
  CUSTOMER_RECEIPT: ['payment.customer.receive'],
  CUSTOMER_REFUND: ['payment.customer.refund'],
  SUPPLIER_BILL: ['booking.issue', 'booking.adjust_price', 'booking.change_supplier', 'booking.reissue', 'refund.manage'],
  SUPPLIER_CREDIT_NOTE: ['booking.adjust_price', 'booking.change_supplier', 'booking.void', 'refund.manage'],
  SUPPLIER_PAYMENT: ['payment.supplier.pay'],
  SUPPLIER_REFUND: ['payment.supplier.record_refund'],
  EXPENSE: ['expense.create'],
  MONEY_TRANSFER: ['treasury.transfer'],
  BALANCE_APPLICATION: ['balance.apply'],
  OPENING_BALANCE: ['finance.opening_balances'],
  FX_ADJUSTMENT: ['finance.override_rate'],
};

export const DOCUMENT_REVERSE_PERMISSIONS: Readonly<Record<DocType, readonly string[]>> = {
  CUSTOMER_INVOICE: ['booking.adjust_price'],
  CUSTOMER_CREDIT_NOTE: ['booking.adjust_price'],
  CUSTOMER_RECEIPT: ['payment.customer.reverse'],
  CUSTOMER_REFUND: ['payment.customer.reverse'],
  SUPPLIER_BILL: ['booking.adjust_price'],
  SUPPLIER_CREDIT_NOTE: ['booking.adjust_price'],
  SUPPLIER_PAYMENT: ['payment.supplier.reverse'],
  SUPPLIER_REFUND: ['payment.supplier.reverse'],
  EXPENSE: ['expense.reverse'],
  MONEY_TRANSFER: ['treasury.transfer'],
  BALANCE_APPLICATION: ['balance.apply'],
  OPENING_BALANCE: ['finance.opening_balances'],
  FX_ADJUSTMENT: ['finance.override_rate'],
};
