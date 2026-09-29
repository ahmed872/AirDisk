import { z } from 'zod';

/**
 * Input schemas for every backend command (validated at the transport
 * boundary before any handler runs). Strings are trimmed and bounded; money is
 * integer minor units; dates are ISO; nothing unbounded crosses the IPC line.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID');
export const currencyCode = z.string().regex(/^[A-Z]{3}$/);
export const locale = z.enum(['ar', 'en']);
const username = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, . _ -');
const password = z.string().min(1).max(128);
const roleCode = z.string().trim().min(2).max(40).regex(/^[A-Z][A-Z0-9_]*$/);
const permissionCode = z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/);

export const companyProfileInput = z
  .object({
    legalNameAr: text(200),
    legalNameEn: optText(200),
    tradeNameAr: optText(200),
    tradeNameEn: optText(200),
    addressAr: optText(500),
    addressEn: optText(500),
    phonePrimary: optText(40),
    phoneSecondary: optText(40),
    email: z.string().trim().email().max(200).optional().nullable().or(z.literal('')),
    website: optText(200),
    taxRegistrationNo: optText(60),
    commercialRegistrationNo: optText(60),
    iataAgencyCode: optText(20),
    baseCurrencyCode: currencyCode,
    defaultCountryCode: z.string().regex(/^[A-Z]{2}$/),
    timezone: text(64),
    defaultLocale: locale,
    documentFooterAr: optText(1000),
    documentFooterEn: optText(1000),
    invoiceTitleAr: optText(200),
    invoiceTitleEn: optText(200),
    invoiceTermsAr: optText(2000),
    invoiceTermsEn: optText(2000),
    dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).optional(),
    numberFormat: z.enum(['LATIN', 'ARABIC_INDIC']).optional(),
    textDirection: z.enum(['AUTO', 'RTL', 'LTR']).optional(),
    /** base64 image; bounded to ~512 KB decoded. */
    logoBase64: z.string().max(700_000).optional().nullable(),
    logoMime: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']).optional().nullable(),
  })
  .strict();
export type CompanyProfileInput = z.infer<typeof companyProfileInput>;

// Master data inputs are shape-checked here; business validation (phones,
// codes, countries, dates) happens in the domain layer on the backend.
const s = (max: number) => z.string().max(max).optional().nullable();
export const customerInput = z
  .object({
    customerType: z.enum(['INDIVIDUAL', 'CORPORATE']).optional(),
    fullName: z.string().max(200),
    fullNameLatin: s(200),
    primaryMobile: z.string().max(40),
    secondaryMobile: s(40),
    whatsappNumber: s(40),
    email: s(200),
    address: s(500),
    nationality: s(2),
    nationalId: s(40),
    passportNo: s(20),
    passportExpiry: s(10),
    dateOfBirth: s(10),
    preferredLocale: locale.optional().nullable(),
    paymentTermsDays: z.number().int().min(0).max(365).optional().nullable(),
    notes: s(2000),
  })
  .strict();
export type CustomerInputDto = z.infer<typeof customerInput>;

export const supplierInput = z
  .object({
    name: z.string().max(200),
    contactPerson: s(200),
    phonePrimary: s(40),
    phoneSecondary: s(40),
    email: s(200),
    address: s(500),
    countryCode: s(2),
    defaultCurrencyCode: z.string().max(3),
    paymentTermsDays: z.number().int().min(0).max(365).optional().nullable(),
    airlineId: ulid.optional().nullable(),
    notes: s(2000),
  })
  .strict();
export type SupplierInputDto = z.infer<typeof supplierInput>;

export const airlineInput = z
  .object({
    nameEn: z.string().max(200),
    nameAr: s(200),
    iataCode: s(2),
    icaoCode: s(3),
    ticketPrefix: s(3),
    countryCode: s(2),
    phone: s(40),
    email: s(200),
    website: s(200),
    notes: s(2000),
  })
  .strict();
export type AirlineInputDto = z.infer<typeof airlineInput>;

const statusFilter = z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE');
const listQuery = <F extends [string, ...string[]]>(sortFields: F) =>
  z
    .object({
      query: z.string().max(100).optional(),
      status: statusFilter,
      sortBy: z.enum(sortFields).optional(),
      sortDir: z.enum(['asc', 'desc']).default('asc'),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    })
    .strict();
const idOnly = z.object({ id: ulid }).strict();
const statusChange = z.object({ id: ulid, reason: optText(500) }).strict();

/** Money in minor units: positive safe integers, bounded (≈ 90 trillion) so arithmetic can never overflow. */
const MAX_MINOR = 9_000_000_000_000;
const minor = z.number().int().min(1).max(MAX_MINOR);
const rateText = z.string().trim().min(1).max(30);
const paymentMethod = z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'WALLET', 'OTHER']);

export const airportInput = z
  .object({
    iataCode: z.string().max(3), icaoCode: s(4), nameEn: z.string().max(120), nameAr: s(120), cityEn: s(80), cityAr: s(80), countryCode: z.string().max(2), timezone: s(64),
  })
  .strict();

export const passengerInput = z
  .object({
    paxType: z.enum(['ADT', 'CHD', 'INF']).optional().nullable(), title: s(10), givenName: z.string().max(60), surname: z.string().max(60), nameAr: s(120),
    gender: z.enum(['M', 'F', 'X']).optional().nullable(), dateOfBirth: s(10), nationality: s(2), passportNo: s(20), passportExpiry: s(10),
    idDocumentType: z.enum(['PASSPORT', 'NATIONAL_ID', 'OTHER']).optional().nullable(), idDocumentNo: s(40), frequentFlyerNo: s(30), mobile: s(40), notes: s(1000),
  })
  .strict();

export const segmentInput = z
  .object({
    airlineId: ulid, operatingAirlineId: ulid.optional().nullable(), flightNumber: z.string().max(8), origin: z.string().max(3), destination: z.string().max(3),
    departureDate: z.string().max(10), departureTime: z.string().max(5), arrivalDate: z.string().max(10), arrivalTime: z.string().max(5),
    cabinClass: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).optional().nullable(), bookingClass: s(2), departureTerminal: s(10),
    arrivalTerminal: s(10), baggage: s(40), seat: s(10), airlineLocator: s(10), status: z.enum(['CONFIRMED', 'WAITLISTED', 'CANCELLED']).optional().nullable(), notes: s(500),
  })
  .strict();

const amount0 = z.number().int().min(0).max(MAX_MINOR);
export const priceItemInput = z
  .object({
    passengerId: ulid, supplierId: ulid.optional().nullable(), validatingAirlineId: ulid.optional().nullable(), ticketNumber: s(20),
    fareMinor: amount0, taxesMinor: amount0.optional(), serviceFeeMinor: amount0.optional(), discountMinor: amount0.optional(),
    costCurrency: currencyCode.optional().nullable(), costMinor: amount0.optional().nullable(), supplierReference: s(60), notes: s(500),
  })
  .strict();

const paymentInput = z
  .object({
    partyId: ulid, date: isoDate.optional().nullable(), currency: currencyCode, amountMinor: minor, moneyAccountId: ulid, paymentMethod,
    reference: optText(60), notes: optText(500), exchangeRate: rateText.optional().nullable(),
    allocations: z.array(z.object({ bookingId: ulid, amountMinor: minor }).strict()).max(100),
    onAccountMinor: z.number().int().min(0).max(MAX_MINOR).optional(),
  })
  .strict();

export const commandSchemas = {
  'system.status': z.object({}).strict(),
  'system.setup': z
    .object({
      company: companyProfileInput,
      admin: z.object({ username, displayName: text(100), password, locale }).strict(),
    })
    .strict(),

  'auth.login': z.object({ username: z.string().trim().min(1).max(40), password }).strict(),
  'auth.logout': z.object({}).strict(),
  'auth.me': z.object({}).strict(),
  'auth.changePassword': z.object({ currentPassword: password, newPassword: password }).strict(),

  'company.get': z.object({}).strict(),
  'company.update': z.object({ profile: companyProfileInput, rowVersion: z.number().int().positive() }).strict(),
  'company.setLockDate': z.object({ lockDate: isoDate, reason: optText(500) }).strict(),

  'currency.list': z.object({}).strict(),
  'currency.setRate': z.object({ currencyCode, rateDate: isoDate, rate: z.string().trim().min(1).max(30) }).strict(),

  'users.list': z.object({ query: z.string().max(100).optional(), status: z.enum(['ALL', 'ACTIVE', 'DISABLED']).default('ALL') }).strict(),
  'users.create': z
    .object({
      username, displayName: text(100), password, roleCodes: z.array(roleCode).min(1).max(20), locale: locale.optional(),
      email: s(200), mobile: s(40), notes: s(2000),
    })
    .strict(),
  'users.update': z
    .object({ userId: ulid, displayName: text(100), email: s(200), mobile: s(40), notes: s(2000), locale: locale.optional().nullable(), rowVersion: z.number().int().positive() })
    .strict(),
  'users.unlock': z.object({ userId: ulid }).strict(),
  'users.setRoles': z.object({ userId: ulid, roleCodes: z.array(roleCode).min(1).max(20) }).strict(),
  'users.setActive': z.object({ userId: ulid, active: z.boolean() }).strict(),
  'users.resetPassword': z.object({ userId: ulid, newPassword: password }).strict(),

  'roles.list': z.object({}).strict(),
  'roles.create': z
    .object({ code: roleCode, nameAr: text(100), nameEn: text(100), permissions: z.array(permissionCode).max(500) })
    .strict(),
  'roles.update': z.object({ roleId: ulid, nameAr: text(100), nameEn: text(100), description: optText(500) }).strict(),
  'roles.setPermissions': z.object({ roleId: ulid, permissions: z.array(permissionCode).max(500) }).strict(),
  'permissions.list': z.object({}).strict(),

  'ledger.summary': z.object({ from: isoDate, to: isoDate }).strict(),
  'ledger.trialBalance': z.object({ asOf: isoDate }).strict(),

  'integrity.run': z.object({}).strict(),

  'backup.create': z.object({ destinationDir: z.string().max(1000).optional() }).strict(),
  'backup.list': z.object({}).strict(),
  'backup.schedule': z.object({}).strict(),
  'backup.setSchedule': z.object({ intervalHours: z.number().int().min(0).max(720), keep: z.number().int().min(1).max(365) }).strict(),
  'backup.restore': z.object({ filePath: z.string().min(1).max(1000), password, confirmation: z.literal('RESTORE') }).strict(),

  'audit.list': z
    .object({
      limit: z.number().int().min(1).max(500).default(100),
      beforeSeq: z.number().int().positive().optional(),
      entityType: z.string().max(40).optional(),
      entityId: z.string().max(60).optional(),
      action: z.string().max(60).optional(),
      userId: ulid.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
    })
    .strict(),

  'dashboard.summary': z.object({}).strict(),

  'customers.list': listQuery(['customerNo', 'fullName', 'createdAt', 'updatedAt']),
  'customers.get': idOnly,
  'customers.checkDuplicates': z.object({ customer: customerInput.partial(), excludeId: ulid.optional() }).strict(),
  'customers.create': z.object({ customer: customerInput, confirmDuplicates: z.boolean().default(false) }).strict(),
  'customers.update': z.object({ id: ulid, customer: customerInput, rowVersion: z.number().int().positive(), confirmDuplicates: z.boolean().default(false) }).strict(),
  'customers.archive': statusChange,
  'customers.restore': statusChange,

  'suppliers.list': listQuery(['supplierNo', 'name', 'createdAt', 'updatedAt']),
  'suppliers.get': idOnly,
  'suppliers.create': z.object({ supplier: supplierInput, confirmDuplicates: z.boolean().default(false) }).strict(),
  'suppliers.update': z.object({ id: ulid, supplier: supplierInput, rowVersion: z.number().int().positive(), confirmDuplicates: z.boolean().default(false) }).strict(),
  'suppliers.archive': statusChange,
  'suppliers.restore': statusChange,

  'airlines.list': listQuery(['nameEn', 'iataCode', 'createdAt', 'updatedAt']),
  'airlines.get': idOnly,
  'airlines.create': z.object({ airline: airlineInput, confirmDuplicates: z.boolean().default(false) }).strict(),
  'airlines.update': z.object({ id: ulid, airline: airlineInput, rowVersion: z.number().int().positive(), confirmDuplicates: z.boolean().default(false) }).strict(),
  'airlines.archive': statusChange,
  'airlines.restore': statusChange,

  // ── Operations ─────────────────────────────────────────────────────────
  'system.about': z.object({}).strict(),

  'airports.list': listQuery(['name', 'iataCode', 'country']),
  'airports.create': z.object({ airport: airportInput }).strict(),
  'airports.update': z.object({ airport: airportInput, rowVersion: z.number().int().positive() }).strict(),
  'airports.setActive': z.object({ iataCode: z.string().regex(/^[A-Za-z]{3}$/), active: z.boolean() }).strict(),

  'moneyAccounts.list': z.object({ includeInactive: z.boolean().default(false) }).strict(),
  'moneyAccounts.save': z
    .object({
      id: ulid.optional(), name: text(80), accountType: z.enum(['CASH', 'BANK', 'WALLET', 'CARD_CLEARING']), currencyCode,
      bankName: optText(80), accountRef: optText(60), notes: optText(500), rowVersion: z.number().int().positive().optional(),
    })
    .strict(),
  'moneyAccounts.setActive': z.object({ id: ulid, active: z.boolean() }).strict(),

  'expenseCategories.list': z.object({ includeArchived: z.boolean().default(false) }).strict(),
  'expenseCategories.accounts': z.object({}).strict(),
  'expenseCategories.save': z
    .object({ id: ulid.optional(), code: text(30), nameAr: text(80), nameEn: text(80), accountCode: z.string().regex(/^\d{4}$/).optional().nullable(), rowVersion: z.number().int().positive().optional() })
    .strict(),
  'expenseCategories.setActive': z.object({ id: ulid, active: z.boolean() }).strict(),

  'currency.setActive': z.object({ currencyCode, active: z.boolean() }).strict(),
  'currency.rates': z.object({ currencyCode: currencyCode.optional() }).strict(),
  'currency.rateOn': z.object({ currencyCode, date: isoDate }).strict(),

  'bookings.list': z
    .object({
      query: z.string().max(100).optional(),
      status: z.enum(['ALL', 'OPEN', 'DRAFT', 'RESERVED', 'ISSUED', 'PARTIALLY_CANCELLED', 'CANCELLED', 'VOIDED', 'DISCARDED']).default('ALL'),
      from: isoDate.optional(), to: isoDate.optional(), customerId: ulid.optional(), unpaidOnly: z.boolean().optional(),
      sortDir: z.enum(['asc', 'desc']).default('desc'), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0),
    })
    .strict(),
  'bookings.get': idOnly,
  'bookings.create': z
    .object({
      customerId: ulid, pnr: s(10), saleCurrency: currencyCode.optional().nullable(), airlineId: ulid.optional().nullable(), supplierId: ulid.optional().nullable(),
      contactName: s(120), contactMobile: s(40), contactWhatsapp: s(40), contactEmail: s(200), notes: s(2000),
    })
    .strict(),
  'bookings.update': z
    .object({
      id: ulid, rowVersion: z.number().int().positive(),
      patch: z
        .object({
          pnr: s(10), airlineId: ulid.optional().nullable(), supplierId: ulid.optional().nullable(), saleCurrency: currencyCode.optional(),
          contactName: z.string().max(120).optional(), contactMobile: z.string().max(40).optional(), contactWhatsapp: s(40), contactEmail: s(200), notes: s(2000),
          ticketingDeadlineAt: s(30),
        })
        .strict(),
    })
    .strict(),
  'bookings.savePassenger': z.object({ bookingId: ulid, passengerId: ulid.optional().nullable(), passenger: passengerInput }).strict(),
  'bookings.removePassenger': z.object({ bookingId: ulid, passengerId: ulid }).strict(),
  'bookings.saveSegment': z.object({ bookingId: ulid, segmentId: ulid.optional().nullable(), segment: segmentInput, reason: s(500), source: z.enum(['MANUAL', 'AIRLINE_NOTICE']).optional() }).strict(),
  'bookings.removeSegment': z.object({ bookingId: ulid, segmentId: ulid }).strict(),
  'bookings.savePriceItem': z.object({ bookingId: ulid, itemId: ulid.optional().nullable(), item: priceItemInput }).strict(),
  'bookings.removePriceItem': z.object({ bookingId: ulid, itemId: ulid }).strict(),
  'bookings.reserve': z.object({ id: ulid, rowVersion: z.number().int().positive(), ticketingDeadlineAt: s(30) }).strict(),
  'bookings.release': z.object({ id: ulid, rowVersion: z.number().int().positive() }).strict(),
  'bookings.discard': z.object({ id: ulid, rowVersion: z.number().int().positive(), reason: text(500) }).strict(),
  'bookings.issue': z
    .object({
      id: ulid, rowVersion: z.number().int().positive(), issueDate: isoDate.optional().nullable(), saleExchangeRate: rateText.optional().nullable(),
      costExchangeRates: z.record(currencyCode, rateText).optional().nullable(),
    })
    .strict(),
  'bookings.setTicketNumber': z.object({ bookingId: ulid, ticketId: ulid, ticketNumber: text(20) }).strict(),
  'bookings.adjustSale': z
    .object({
      bookingId: ulid, ticketId: ulid.optional().nullable(), kind: z.enum(['INCREASE', 'DECREASE']),
      lineType: z.enum(['FARE', 'TAXES', 'SERVICE_FEE', 'CHANGE_FEE']).optional().nullable(), amountMinor: minor, reason: text(500), date: isoDate.optional().nullable(),
    })
    .strict(),
  'bookings.adjustCost': z
    .object({
      bookingId: ulid, ticketId: ulid, kind: z.enum(['INCREASE', 'DECREASE']), lineType: z.enum(['PURCHASE_COST', 'SUPPLIER_PENALTY']).optional().nullable(),
      amountMinor: minor, reason: text(500), date: isoDate.optional().nullable(), externalReference: optText(60),
    })
    .strict(),
  'bookings.changeSupplier': z
    .object({ bookingId: ulid, ticketId: ulid, newSupplierId: ulid, costMinor: z.number().int().min(0).max(MAX_MINOR), costCurrency: currencyCode, reason: text(500), date: isoDate.optional().nullable() })
    .strict(),
  'bookings.reissue': z
    .object({
      bookingId: ulid, ticketId: ulid, rowVersion: z.number().int().min(1), newTicketNumber: z.string().trim().max(20).optional().nullable(),
      fareDifferenceMinor: z.number().int().min(0).max(MAX_MINOR).optional(), changeFeeMinor: z.number().int().min(0).max(MAX_MINOR).optional(), additionalCostMinor: z.number().int().min(0).max(MAX_MINOR).optional(), supplierPenaltyMinor: z.number().int().min(0).max(MAX_MINOR).optional(),
      segments: z.array(z.object({ segmentId: ulid, segment: segmentInput }).strict()).max(20).optional(),
      reason: text(500), date: isoDate.optional().nullable(), externalReference: optText(60),
    })
    .strict(),

  'payments.receive': paymentInput,
  'payments.refundCustomer': paymentInput,
  'payments.paySupplier': paymentInput,
  'payments.supplierRefund': paymentInput,
  'payments.openItems': z.object({ party: z.enum(['CUSTOMER', 'SUPPLIER']), partyId: ulid }).strict(),
  'openingBalances.record': z
    .object({
      target: z.enum(['CUSTOMER', 'SUPPLIER', 'MONEY_ACCOUNT']), targetId: ulid, side: z.enum(['OWED_TO_OFFICE', 'OWED_BY_OFFICE']),
      currency: currencyCode, amountMinor: minor, date: isoDate.optional().nullable(), exchangeRate: rateText.optional().nullable(), notes: optText(500),
    })
    .strict(),
  'openingBalances.list': z.object({}).strict(),
  'treasury.transfer': z
    .object({
      kind: z.enum(['ACCOUNT_TRANSFER', 'OWNER_CAPITAL', 'OWNER_DRAWING']), fromAccountId: ulid.optional().nullable(), toAccountId: ulid.optional().nullable(),
      amountMinor: minor, date: isoDate.optional().nullable(), exchangeRate: rateText.optional().nullable(), reference: optText(60), notes: optText(500),
    })
    .strict(),
  'treasury.transfers': z.object({ from: isoDate, to: isoDate }).strict(),
  'balances.apply': z
    .object({
      party: z.enum(['CUSTOMER', 'SUPPLIER']), partyId: ulid, currency: currencyCode, fromBookingId: ulid.optional().nullable(),
      allocations: z.array(z.object({ bookingId: ulid, amountMinor: minor }).strict()).min(1).max(100), date: isoDate.optional().nullable(), notes: optText(500),
    })
    .strict(),
  'documents.get': idOnly,
  'documents.cancel': z.object({ id: ulid, reason: text(500), date: isoDate.optional().nullable() }).strict(),

  'expenses.create': z
    .object({
      categoryId: ulid, date: isoDate.optional().nullable(), currency: currencyCode, amountMinor: minor, moneyAccountId: ulid, paymentMethod,
      reference: optText(60), description: text(500), exchangeRate: rateText.optional().nullable(),
    })
    .strict(),

  'cancellations.list': z.object({ status: z.enum(['OPEN', 'CLOSED', 'WITHDRAWN', 'ALL']).default('OPEN') }).strict(),
  'cancellations.get': idOnly,
  'cancellations.request': z
    .object({
      bookingId: ulid, cancelType: z.enum(['VOID', 'REFUND', 'NON_REFUNDABLE']), ticketIds: z.array(ulid).max(50).optional().nullable(), reason: text(500),
      expectedSupplierRefundMinor: z.number().int().min(0).max(MAX_MINOR).optional().nullable(), expectedCurrency: currencyCode.optional().nullable(), notes: optText(1000),
    })
    .strict(),
  'cancellations.submit': z.object({ id: ulid, rowVersion: z.number().int().positive() }).strict(),
  'cancellations.confirmSupplier': z
    .object({
      id: ulid, rowVersion: z.number().int().positive(), date: isoDate.optional().nullable(), externalReference: optText(60),
      lines: z.array(z.object({ ticketId: ulid, returnMinor: z.number().int().min(0).max(MAX_MINOR), penaltyMinor: z.number().int().min(0).max(MAX_MINOR).optional() }).strict()).min(1).max(50),
    })
    .strict(),
  'cancellations.rejectSupplier': z.object({ id: ulid, rowVersion: z.number().int().positive(), note: text(500) }).strict(),
  'cancellations.creditCustomer': z
    .object({
      id: ulid, rowVersion: z.number().int().positive(), date: isoDate.optional().nullable(), cancellationFeeMinor: z.number().int().min(0).max(MAX_MINOR).optional(),
      lines: z.array(z.object({ ticketId: ulid, returnMinor: z.number().int().min(0).max(MAX_MINOR) }).strict()).max(50),
    })
    .strict(),
  'cancellations.customerNotApplicable': z.object({ id: ulid, rowVersion: z.number().int().positive(), note: text(500) }).strict(),
  'cancellations.withdraw': z.object({ id: ulid, rowVersion: z.number().int().positive(), reason: text(500) }).strict(),

  'schedule.list': z.object({ attentionOnly: z.boolean().optional(), from: isoDate.optional(), to: isoDate.optional() }).strict(),
  'schedule.setStatus': z
    .object({
      id: ulid, rowVersion: z.number().int().positive(), status: z.enum(['CUSTOMER_NOTIFIED', 'NOTIFICATION_FAILED', 'MANUALLY_CONFIRMED']), note: optText(500),
      customerResponse: z.enum(['ACCEPTED', 'REQUESTED_CHANGE', 'REQUESTED_REFUND']).optional().nullable(),
    })
    .strict(),
  'notifications.channels': z.object({}).strict(),
  'notifications.draft': z.object({ changeId: ulid, locale }).strict(),
  'notifications.record': z
    .object({
      bookingId: ulid, scheduleChangeId: ulid.optional().nullable(), channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PHONE_CALL']), recipient: text(120),
      body: text(4000), outcome: z.enum(['SENT', 'FAILED']), note: optText(500),
    })
    .strict(),
  'travel.upcoming': z.object({ from: isoDate, to: isoDate, attentionOnly: z.boolean().optional() }).strict(),

  'statements.get': z.object({ party: z.enum(['CUSTOMER', 'SUPPLIER']), partyId: ulid, from: isoDate, to: isoDate }).strict(),
  'aging.get': z.object({ party: z.enum(['CUSTOMER', 'SUPPLIER']), asOf: isoDate }).strict(),
  'reports.run': z
    .object({
      report: z.enum(['sales', 'purchases', 'profit', 'receivables', 'payables', 'supplier_volume', 'expenses', 'refunds', 'cancellations', 'flight_changes', 'employee_activity', 'collections']),
      from: isoDate, to: isoDate,
    })
    .strict(),
  'dashboard.metrics': z.object({ from: isoDate, to: isoDate }).strict(),
  'search.global': z.object({ query: z.string().max(100) }).strict(),
} as const;

export type CommandName = keyof typeof commandSchemas;
export type CommandInput<C extends CommandName> = z.input<(typeof commandSchemas)[C]>;
export const COMMAND_NAMES = Object.keys(commandSchemas) as CommandName[];
