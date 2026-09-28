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
  isActive: boolean;
  isLocked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  roles: string[];
}

export interface RoleDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  isSystem: boolean;
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
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
}
