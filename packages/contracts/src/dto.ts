import type { ErrorCode } from '@airdesk/domain';

/** Transport envelope: every command resolves to exactly one of these. */
export type CommandResult<T = unknown> = { ok: true; data: T } | { ok: false; error: CommandError };

export interface CommandError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface SystemStatusDto {
  setupRequired: boolean;
  appVersion: string;
  schemaVersion: number;
  companyName: string | null;
  defaultLocale: 'ar' | 'en';
}

export interface SessionUserDto {
  id: string;
  username: string;
  displayName: string;
  locale: 'ar' | 'en' | null;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

export interface CompanyProfileDto {
  legalNameAr: string;
  legalNameEn: string | null;
  tradeNameAr: string | null;
  tradeNameEn: string | null;
  addressAr: string | null;
  addressEn: string | null;
  phonePrimary: string | null;
  phoneSecondary: string | null;
  email: string | null;
  website: string | null;
  taxRegistrationNo: string | null;
  commercialRegistrationNo: string | null;
  iataAgencyCode: string | null;
  baseCurrencyCode: string;
  baseCurrencyFrozen: boolean;
  defaultCountryCode: string;
  timezone: string;
  defaultLocale: 'ar' | 'en';
  financialLockDate: string | null;
  documentFooterAr: string | null;
  documentFooterEn: string | null;
  invoiceTitleAr: string | null;
  invoiceTitleEn: string | null;
  invoiceTermsAr: string | null;
  invoiceTermsEn: string | null;
  dateFormat: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
  numberFormat: 'LATIN' | 'ARABIC_INDIC';
  textDirection: 'AUTO' | 'RTL' | 'LTR';
  logoBase64: string | null;
  logoMime: string | null;
  rowVersion: number;
}

export interface CurrencyDto {
  code: string;
  nameAr: string;
  nameEn: string;
  symbol: string | null;
  minorUnit: number;
  isActive: boolean;
}

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  mobile: string | null;
  notes: string | null;
  locale: 'ar' | 'en' | null;
  status: 'ACTIVE' | 'LOCKED' | 'DISABLED';
  isActive: boolean;
  isLocked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
  roles: string[];
}

export interface RoleDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissions: string[];
}

export interface PermissionDto {
  code: string;
  module: string;
  sensitive: boolean;
  ar: string;
  en: string;
}

/** All amounts in base-currency minor units. */
export interface LedgerSummaryDto {
  from: string;
  to: string;
  baseCurrency: string;
  sales: number;
  purchases: number;
  grossProfit: number;
  expenses: number;
  otherIncome: number;
  netProfit: number;
  collections: number;
  supplierPayments: number;
  receivables: number;
  customerCredits: number;
  payables: number;
  supplierCredits: number;
}

export interface TrialBalanceRowDto {
  accountCode: string;
  nameAr: string;
  nameEn: string;
  accountClass: string;
  debitBaseMinor: number;
  creditBaseMinor: number;
}

export interface IntegrityCheckDto {
  id: string;
  ok: boolean;
  details?: string;
}

export interface IntegrityReportDto {
  ok: boolean;
  ranAt: string;
  checks: IntegrityCheckDto[];
}

export interface BackupRecordDto {
  id: string;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  filePath: string | null;
  fileSizeBytes: number | null;
  sha256: string | null;
  schemaVersion: number;
  verifiedAt: string | null;
  errorMessage: string | null;
}

export interface AuditEntryDto {
  seq: number;
  occurredAt: string;
  userId: string | null;
  username: string | null;
  workstation: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
}

export interface PageDto<T> {
  items: T[];
  total: number;
}

export type RecordStatusDto = 'ACTIVE' | 'ARCHIVED';

/** Balance per currency, DERIVED from the journal (never a stored column). Minor units. */
export interface PartyBalanceDto {
  currency: string;
  balanceMinor: number;
}

export interface CustomerDto {
  id: string;
  customerNo: string;
  customerType: 'INDIVIDUAL' | 'CORPORATE';
  fullName: string;
  fullNameLatin: string | null;
  primaryMobile: string;
  primaryMobileRaw: string;
  secondaryMobile: string | null;
  whatsappNumber: string | null;
  email: string | null;
  address: string | null;
  nationality: string | null;
  /** Identity fields are null when the caller lacks customer.view_identity (identityRedacted = true). */
  nationalId: string | null;
  passportNo: string | null;
  passportExpiry: string | null;
  dateOfBirth: string | null;
  identityRedacted: boolean;
  preferredLocale: 'ar' | 'en' | null;
  paymentTermsDays: number;
  notes: string | null;
  status: RecordStatusDto;
  balances: PartyBalanceDto[];
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  rowVersion: number;
}

export interface SupplierDto {
  id: string;
  supplierNo: string;
  name: string;
  contactPerson: string | null;
  phonePrimary: string | null;
  phoneSecondary: string | null;
  email: string | null;
  address: string | null;
  countryCode: string | null;
  defaultCurrencyCode: string;
  paymentTermsDays: number;
  airlineId: string | null;
  notes: string | null;
  status: RecordStatusDto;
  /** null unless the caller holds supplier.view_financial. */
  balances: PartyBalanceDto[] | null;
  financialRedacted: boolean;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  rowVersion: number;
}

export interface AirlineDto {
  id: string;
  nameEn: string;
  nameAr: string | null;
  iataCode: string | null;
  icaoCode: string | null;
  ticketPrefix: string | null;
  countryCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  status: RecordStatusDto;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

export interface DuplicateCandidateDto {
  id: string;
  number: string;
  name: string;
  status: RecordStatusDto;
  signals: string[];
}

export interface DashboardSummaryDto {
  customers: { active: number; archived: number } | null;
  suppliers: { active: number; archived: number } | null;
  airlines: { active: number; archived: number } | null;
  users: { active: number; disabled: number } | null;
  lastBackupAt: string | null;
}
