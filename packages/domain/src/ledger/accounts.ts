/**
 * System chart of accounts (Phase 0 §04-3). Codes are referenced by posting
 * rules and are therefore fixed. Migration 0001 seeds exactly these rows; a
 * test asserts the database and this table never drift apart.
 */
export type AccountClass =
  | 'ASSET'
  | 'LIABILITY'
  | 'EQUITY'
  | 'REVENUE'
  | 'CONTRA_REVENUE'
  | 'COST'
  | 'CONTRA_COST'
  | 'EXPENSE'
  | 'OTHER';

export type NormalSide = 'DEBIT' | 'CREDIT';

/** Which analytical dimension a journal line on this account MUST carry. */
export type AccountDimension = 'NONE' | 'CUSTOMER' | 'SUPPLIER' | 'MONEY_ACCOUNT';

export interface AccountDefinition {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly accountClass: AccountClass;
  readonly normalSide: NormalSide;
  readonly dimension: AccountDimension;
}

export const ACCOUNT = {
  CASH: '1110',
  RECEIVABLE: '1200',
  PAYABLE: '2100',
  OPENING_EQUITY: '3100',
  OWNER: '3200',
  TICKET_SALES: '4100',
  SALES_RETURNS: '4110',
  DISCOUNTS: '4120',
  SERVICE_FEES: '4200',
  CANCELLATION_FEES: '4210',
  PURCHASE_COST: '5100',
  PURCHASE_RETURNS: '5110',
  SUPPLIER_PENALTIES: '5200',
  EXP_RENT: '6110',
  EXP_SALARIES: '6120',
  EXP_TELECOM: '6130',
  EXP_UTILITIES: '6140',
  EXP_BANK: '6150',
  EXP_OFFICE: '6160',
  EXP_TRANSPORT: '6170',
  EXP_OTHER: '6190',
  FX: '7100',
  ROUNDING: '7200',
} as const;

const a = (
  code: string,
  nameAr: string,
  nameEn: string,
  accountClass: AccountClass,
  normalSide: NormalSide,
  dimension: AccountDimension = 'NONE',
): AccountDefinition => ({ code, nameAr, nameEn, accountClass, normalSide, dimension });

export const SYSTEM_ACCOUNTS: readonly AccountDefinition[] = [
  a(ACCOUNT.CASH, 'النقدية والبنوك', 'Cash & bank', 'ASSET', 'DEBIT', 'MONEY_ACCOUNT'),
  a(ACCOUNT.RECEIVABLE, 'ذمم العملاء', 'Accounts receivable – customers', 'ASSET', 'DEBIT', 'CUSTOMER'),
  a(ACCOUNT.PAYABLE, 'ذمم الموردين', 'Accounts payable – suppliers', 'LIABILITY', 'CREDIT', 'SUPPLIER'),
  a(ACCOUNT.OPENING_EQUITY, 'أرصدة افتتاحية', 'Opening balance equity', 'EQUITY', 'CREDIT'),
  a(ACCOUNT.OWNER, 'جاري المالك', 'Owner capital & drawings', 'EQUITY', 'CREDIT'),
  a(ACCOUNT.TICKET_SALES, 'مبيعات التذاكر', 'Ticket sales', 'REVENUE', 'CREDIT'),
  a(ACCOUNT.SALES_RETURNS, 'مردودات وإلغاءات المبيعات', 'Sales returns & cancellations', 'CONTRA_REVENUE', 'DEBIT'),
  a(ACCOUNT.DISCOUNTS, 'خصومات مسموح بها', 'Discounts allowed', 'CONTRA_REVENUE', 'DEBIT'),
  a(ACCOUNT.SERVICE_FEES, 'رسوم خدمة وتعديل', 'Service & change fees', 'REVENUE', 'CREDIT'),
  a(ACCOUNT.CANCELLATION_FEES, 'رسوم إلغاء', 'Cancellation fees', 'REVENUE', 'CREDIT'),
  a(ACCOUNT.PURCHASE_COST, 'تكلفة التذاكر', 'Ticket purchase cost', 'COST', 'DEBIT'),
  a(ACCOUNT.PURCHASE_RETURNS, 'مردودات المشتريات', 'Purchase returns (supplier credits)', 'CONTRA_COST', 'CREDIT'),
  a(ACCOUNT.SUPPLIER_PENALTIES, 'غرامات ورسوم الموردين', 'Supplier penalties & charges', 'COST', 'DEBIT'),
  a(ACCOUNT.EXP_RENT, 'إيجار', 'Rent', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.EXP_SALARIES, 'رواتب', 'Salaries', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.EXP_TELECOM, 'إنترنت واتصالات', 'Internet & telecom', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.EXP_UTILITIES, 'كهرباء ومرافق', 'Electricity & utilities', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.EXP_BANK, 'رسوم بنكية', 'Bank charges', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.EXP_OFFICE, 'مصروفات مكتبية', 'Office expenses', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.EXP_TRANSPORT, 'انتقالات', 'Transportation', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.EXP_OTHER, 'مصروفات تشغيل أخرى', 'Other operating expenses', 'EXPENSE', 'DEBIT'),
  a(ACCOUNT.FX, 'فروق عملة محققة', 'Realised FX gain/loss', 'OTHER', 'CREDIT'),
  a(ACCOUNT.ROUNDING, 'فروق تقريب', 'Rounding differences', 'OTHER', 'CREDIT'),
];

/** Default expense categories seeded on a new installation (configurable later). */
export const SEED_EXPENSE_CATEGORIES: ReadonlyArray<{ code: string; nameAr: string; nameEn: string; accountCode: string }> = [
  { code: 'RENT', nameAr: 'إيجار', nameEn: 'Rent', accountCode: ACCOUNT.EXP_RENT },
  { code: 'SALARIES', nameAr: 'رواتب', nameEn: 'Salaries', accountCode: ACCOUNT.EXP_SALARIES },
  { code: 'INTERNET', nameAr: 'إنترنت واتصالات', nameEn: 'Internet & telecom', accountCode: ACCOUNT.EXP_TELECOM },
  { code: 'UTILITIES', nameAr: 'كهرباء ومرافق', nameEn: 'Electricity & utilities', accountCode: ACCOUNT.EXP_UTILITIES },
  { code: 'BANK_CHARGES', nameAr: 'رسوم بنكية', nameEn: 'Bank charges', accountCode: ACCOUNT.EXP_BANK },
  { code: 'OFFICE', nameAr: 'مصروفات مكتبية', nameEn: 'Office expenses', accountCode: ACCOUNT.EXP_OFFICE },
  { code: 'TRANSPORT', nameAr: 'انتقالات', nameEn: 'Transportation', accountCode: ACCOUNT.EXP_TRANSPORT },
  { code: 'OTHER', nameAr: 'مصروفات أخرى', nameEn: 'Other operating expenses', accountCode: ACCOUNT.EXP_OTHER },
];

export class ChartOfAccounts {
  private readonly byCode: ReadonlyMap<string, AccountDefinition>;

  constructor(accounts: readonly AccountDefinition[] = SYSTEM_ACCOUNTS) {
    this.byCode = new Map(accounts.map((acc) => [acc.code, acc]));
  }

  get(code: string): AccountDefinition | undefined {
    return this.byCode.get(code);
  }

  all(): AccountDefinition[] {
    return [...this.byCode.values()];
  }
}

/** Account classes that make up Gross Profit (BR-FIN-01). Cash accounts never do. */
export const GROSS_PROFIT_CLASSES: readonly AccountClass[] = ['REVENUE', 'CONTRA_REVENUE', 'COST', 'CONTRA_COST'];
