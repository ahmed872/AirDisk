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
  /** Only while first-run setup is pending: the currencies that can be chosen as base currency. */
  setupCurrencies?: { code: string; nameAr: string; nameEn: string }[];
  /**
   * NEW: no company data on this PC yet (set up or restore a backup).
   * LOCKED: the data is encrypted and must be unlocked with the recovery passphrase (or restored).
   * READY: open.
   */
  vault: 'NEW' | 'LOCKED' | 'READY';
  lockReason?: 'PASSPHRASE_REQUIRED' | 'KEY_FILE_MISSING' | 'KEY_FILE_DAMAGED' | 'DATABASE_DAMAGED';
  /** Whether the open company data is encrypted at rest (null until known). */
  encrypted: boolean | null;
  /** Seconds to wait before the next unlock attempt (after wrong passphrases). */
  retryAfterSeconds?: number;
}

export interface EncryptionStatusDto {
  encrypted: boolean;
  keyCreatedAt: string | null;
  /** 'dpapi' on Windows: this Windows user opens the data without the passphrase; 'none': passphrase at every start. */
  deviceProtection: string;
  /** Backup files / database copies on this PC that are still unencrypted. */
  unencryptedBackupFiles: number;
}

export interface BackupHeaderDto {
  format: 1 | 2;
  encrypted: boolean;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  kind: string;
  /** When the recovery passphrase that opens this backup was set. */
  keyCreatedAt: string | null;
  /** True when this installation's own key opens it (no passphrase needed). */
  sameKey: boolean;
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

// ───────────────────────── Operations (bookings, finance, reports) ─────────────────────────

export interface AirportDto {
  iataCode: string;
  icaoCode: string | null;
  nameEn: string;
  nameAr: string | null;
  cityEn: string | null;
  cityAr: string | null;
  countryCode: string;
  timezone: string | null;
  status: RecordStatusDto;
  rowVersion: number;
}

export interface MoneyAccountDto {
  id: string;
  name: string;
  accountType: 'CASH' | 'BANK' | 'WALLET' | 'CARD_CLEARING';
  currencyCode: string;
  bankName: string | null;
  accountRef: string | null;
  notes: string | null;
  isActive: boolean;
  rowVersion: number;
  /** Derived from the journal; null without treasury.view. */
  balanceMinor: number | null;
}

export interface ExpenseCategoryDto {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  accountCode: string;
  isSystem: boolean;
  status: RecordStatusDto;
  rowVersion: number;
}

export interface ExchangeRateDto {
  currencyCode: string;
  rateDate: string;
  rate: string;
  createdAt: string;
  createdBy: string | null;
}

export type BookingStatusDto = 'DRAFT' | 'RESERVED' | 'ISSUED' | 'PARTIALLY_CANCELLED' | 'CANCELLED' | 'VOIDED' | 'DISCARDED';
export type SettlementDto = 'NOT_CHARGED' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'CREDIT';
export type RefundStatusDto = 'NONE' | 'PENDING' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export interface MoneyDto {
  currency: string;
  minor: number;
}

/** Customer side of one booking in one currency, derived from the journal. */
export interface CustomerPositionDto {
  currency: string;
  chargedMinor: number;
  paidMinor: number;
  balanceMinor: number;
  settlement: SettlementDto;
}

export interface SupplierPositionDto {
  supplierId: string;
  supplierName: string;
  currency: string;
  billedMinor: number;
  paidMinor: number;
  balanceMinor: number;
  settlement: SettlementDto;
}

export interface BookingListItemDto {
  id: string;
  bookingNo: string;
  pnr: string | null;
  status: BookingStatusDto;
  bookingDate: string;
  issueDate: string | null;
  customerId: string;
  customerName: string;
  customerNo: string;
  contactMobile: string;
  passengerCount: number;
  passengerNames: string;
  route: string | null;
  firstDeparture: string | null;
  airlineName: string | null;
  saleCurrency: string;
  totalMinor: number;
  balanceMinor: number;
  settlement: SettlementDto;
  refundStatus: RefundStatusDto;
  scheduleAttention: boolean;
  agentName: string | null;
}

export interface PassengerDto {
  id: string;
  seq: number;
  paxType: 'ADT' | 'CHD' | 'INF';
  title: string | null;
  givenName: string;
  surname: string;
  nameAr: string | null;
  gender: 'M' | 'F' | 'X' | null;
  dateOfBirth: string | null;
  nationality: string | null;
  /** Masked (last 4) without customer.view_identity. */
  passportNo: string | null;
  passportExpiry: string | null;
  idDocumentType: 'PASSPORT' | 'NATIONAL_ID' | 'OTHER' | null;
  idDocumentNo: string | null;
  frequentFlyerNo: string | null;
  mobile: string | null;
  notes: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  identityMasked: boolean;
  rowVersion: number;
}

export interface SegmentDto {
  id: string;
  seq: number;
  airlineId: string;
  airlineName: string;
  airlineCode: string | null;
  operatingAirlineId: string | null;
  flightNumber: string;
  origin: string;
  originName: string | null;
  destination: string;
  destinationName: string | null;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  cabinClass: 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
  bookingClass: string | null;
  departureTerminal: string | null;
  arrivalTerminal: string | null;
  baggage: string | null;
  seat: string | null;
  airlineLocator: string | null;
  status: 'CONFIRMED' | 'WAITLISTED' | 'CANCELLED';
  notes: string | null;
  version: number;
  scheduleChanged: boolean;
  scheduleAttention: boolean;
  rowVersion: number;
}

export interface PriceItemDto {
  id: string;
  seq: number;
  passengerId: string;
  supplierId: string | null;
  supplierName: string | null;
  validatingAirlineId: string | null;
  ticketNumber: string | null;
  fareMinor: number;
  taxesMinor: number;
  serviceFeeMinor: number;
  discountMinor: number;
  saleTotalMinor: number;
  /** null without booking.view_cost (costEntered still tells whether it was filled in). */
  costCurrency: string | null;
  costMinor: number | null;
  costEntered: boolean;
  supplierReference: string | null;
  notes: string | null;
  ticketId: string | null;
  rowVersion: number;
}

export interface TicketDto {
  id: string;
  ticketNumber: string | null;
  passengerId: string;
  passengerName: string;
  supplierId: string;
  supplierName: string;
  validatingAirlineId: string | null;
  airlineName: string | null;
  status: 'ISSUED' | 'VOIDED' | 'EXCHANGED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'USED';
  issueDate: string;
  notes: string | null;
  /** Reissue/exchange: the ticket this one replaced. */
  exchangedFromId: string | null;
  exchangedFromNumber: string | null;
  /** Net sale on this ticket (sale currency), derived from documents. */
  saleMinor: number;
  saleCurrency: string;
  /** Net cost (supplier currency) — null without booking.view_cost. */
  costMinor: number | null;
  costCurrency: string | null;
  rowVersion: number;
}

export interface DocumentLineDto {
  lineNo: number;
  lineType: string;
  amountMinor: number;
  baseAmountMinor: number;
  description: string | null;
  bookingId: string | null;
  bookingNo: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
  passengerName: string | null;
  expenseCategoryId: string | null;
  expenseCategory: string | null;
}

export interface DocumentDto {
  id: string;
  docNo: string;
  docType: string;
  docDate: string;
  currency: string;
  exchangeRate: string;
  totalMinor: number;
  totalBaseMinor: number;
  customerId: string | null;
  customerName: string | null;
  supplierId: string | null;
  supplierName: string | null;
  bookingId: string | null;
  bookingNo: string | null;
  cancellationRequestId: string | null;
  moneyAccountId: string | null;
  moneyAccountName: string | null;
  /** Money transfers between accounts: the receiving account. */
  counterMoneyAccountId: string | null;
  counterMoneyAccountName: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  externalReference: string | null;
  reasonCode: string | null;
  description: string | null;
  isReversal: boolean;
  reversalOfNo: string | null;
  reversedByNo: string | null;
  createdAt: string;
  createdBy: string | null;
  lines: DocumentLineDto[];
}

export interface CancellationDto {
  id: string;
  requestNo: string;
  bookingId: string;
  bookingNo: string;
  cancelType: 'VOID' | 'REFUND' | 'NON_REFUNDABLE';
  scope: 'FULL' | 'PARTIAL';
  overallStatus: 'OPEN' | 'CLOSED' | 'WITHDRAWN';
  supplierStatus: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'REJECTED' | 'NOT_APPLICABLE';
  customerStatus: 'PENDING' | 'CREDITED' | 'NOT_APPLICABLE';
  tickets: { ticketId: string; ticketNumber: string | null; passengerName: string }[];
  expectedSupplierRefund: MoneyDto | null;
  reason: string;
  requestedAt: string;
  requestedBy: string | null;
  closedAt: string | null;
  notes: string | null;
  documents: { id: string; docNo: string; docType: string; totalMinor: number; currency: string }[];
  rowVersion: number;
}

export interface ScheduleChangeDto {
  id: string;
  bookingId: string;
  bookingNo: string;
  segmentId: string;
  segmentLabel: string;
  severity: 'MINOR' | 'MAJOR';
  fields: { field: string; oldValue: string | null; newValue: string | null }[];
  changedAt: string;
  changedBy: string | null;
  notificationStatus: 'NOT_NOTIFIED' | 'CUSTOMER_NOTIFIED' | 'NOTIFICATION_FAILED' | 'MANUALLY_CONFIRMED';
  confirmationNote: string | null;
  customerResponse: 'ACCEPTED' | 'REQUESTED_CHANGE' | 'REQUESTED_REFUND' | null;
  superseded: boolean;
  requiresAttention: boolean;
  customerName: string | null;
  contactMobile: string | null;
  rowVersion: number;
}

export interface NotificationDto {
  id: string;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PHONE_CALL';
  deliveryMode: 'MANUAL' | 'PROVIDER';
  status: 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
  recipientAddress: string;
  recipientName: string | null;
  body: string;
  note: string | null;
  errorMessage: string | null;
  bookingId: string | null;
  scheduleChangeId: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface NotificationChannelDto {
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL';
  /** Always false in this version: no external provider is connected. */
  providerConfigured: boolean;
  manualAvailable: boolean;
}

export interface BookingDto {
  id: string;
  bookingNo: string;
  status: BookingStatusDto;
  pnr: string | null;
  bookingDate: string;
  issueDate: string | null;
  dueDate: string | null;
  ticketingDeadlineAt: string | null;
  customerId: string;
  customerName: string;
  customerNo: string;
  airlineId: string | null;
  airlineName: string | null;
  defaultSupplierId: string | null;
  defaultSupplierName: string | null;
  saleCurrency: string;
  contactName: string;
  contactMobile: string;
  contactWhatsapp: string | null;
  contactEmail: string | null;
  notes: string | null;
  agentName: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
  rowVersion: number;
  passengers: PassengerDto[];
  segments: SegmentDto[];
  priceItems: PriceItemDto[];
  tickets: TicketDto[];
  quote: { saleTotalMinor: number; costTotals: MoneyDto[] | null; estimatedProfitBaseMinor: number | null };
  customer: CustomerPositionDto[];
  /** null without booking.view_cost / supplier.view_financial. */
  suppliers: SupplierPositionDto[] | null;
  /** Lifetime profit in base currency (all documents of the booking); null without booking.view_profit. */
  profit: { netSalesBaseMinor: number; netCostBaseMinor: number; grossProfitBaseMinor: number } | null;
  documents: DocumentDto[];
  cancellations: CancellationDto[];
  scheduleChanges: ScheduleChangeDto[];
  notifications: NotificationDto[];
  statusHistory: { fromStatus: string | null; toStatus: string; changedAt: string; changedBy: string | null; reason: string | null }[];
  refundStatus: RefundStatusDto;
  can: { viewCost: boolean; viewProfit: boolean; enterCost: boolean };
}

export interface ReportColumnDto {
  key: string;
  label: string;
  type: 'text' | 'date' | 'money' | 'number' | 'code';
}

export interface ReportDto {
  id: string;
  from: string | null;
  to: string | null;
  baseCurrency: string;
  columns: ReportColumnDto[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number> | null;
  notes: string[];
}

export interface StatementLineDto {
  date: string;
  docId: string;
  docNo: string;
  docType: string;
  description: string | null;
  bookingNo: string | null;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export interface StatementDto {
  party: 'CUSTOMER' | 'SUPPLIER';
  partyId: string;
  partyName: string;
  partyNo: string;
  currency: string;
  from: string;
  to: string;
  openingMinor: number;
  closingMinor: number;
  totals: { chargesMinor: number; paymentsMinor: number; refundsMinor: number; adjustmentsMinor: number };
  lines: StatementLineDto[];
}

export interface AgingRowDto {
  partyId: string;
  partyName: string;
  partyNo: string;
  currency: string;
  currentMinor: number;
  d1to7Minor: number;
  d8to30Minor: number;
  d31to60Minor: number;
  d60PlusMinor: number;
  totalMinor: number;
  /** Credit balances (we owe them / they owe us) and unapplied on-account amounts, shown separately. */
  creditMinor: number;
}

export interface DashboardMetricsDto {
  from: string;
  to: string;
  baseCurrency: string;
  operational: {
    bookingsCreated: number;
    bookingsIssued: number;
    ticketsIssued: number;
    cancellations: number;
    upcomingDepartures: number;
    changesRequiringAttention: number;
    openRefundRequests: number;
  } | null;
  financial: {
    sales: number;
    collections: number;
    purchases: number;
    grossProfit: number;
    expenses: number;
    netProfit: number;
    receivables: number;
    payables: number;
    customerRefunds: number;
    supplierRefunds: number;
  } | null;
}

export interface UpcomingTravelDto {
  segmentId: string;
  bookingId: string;
  bookingNo: string;
  pnr: string | null;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  origin: string;
  destination: string;
  flight: string;
  airlineName: string;
  passengers: string;
  customerName: string;
  contactMobile: string;
  bookingStatus: BookingStatusDto;
  segmentStatus: string;
  scheduleChanged: boolean;
  scheduleAttention: boolean;
  notificationStatus: string | null;
}

export interface SearchHitDto {
  type: 'customer' | 'supplier' | 'airline' | 'airport' | 'booking';
  id: string;
  title: string;
  subtitle: string | null;
}

export interface AboutDto {
  appVersion: string;
  schemaVersion: number;
  latestSchemaVersion: number;
  migrations: { version: number; name: string; appliedAt: string; appVersion: string }[];
  platform: string;
  dataDirectory: string | null;
}
