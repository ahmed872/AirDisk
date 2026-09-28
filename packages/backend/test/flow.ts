import type { AirlineDto, BookingDto, CustomerDto, DocumentDto, MoneyAccountDto, SupplierDto } from '@airdesk/contracts';
import { expect } from 'vitest';
import type { TestEnv } from './helpers';

/** Thin, typed wrappers around the command dispatcher for end-to-end business flows. */
export async function ok<T>(env: TestEnv, command: string, payload: unknown, session: string): Promise<T> {
  const r = await env.call<T>(command, payload, session);
  if (!r.ok) throw new Error(`${command} failed: ${JSON.stringify(r.error)}`);
  return r.data as T;
}

export async function fail(env: TestEnv, command: string, payload: unknown, session: string): Promise<{ code: string; reason?: string }> {
  const r = await env.call(command, payload, session);
  expect(r.ok, `${command} should fail`).toBe(false);
  if (r.ok) throw new Error('unreachable');
  return { code: r.error.code, reason: r.error.details?.reason as string | undefined };
}

export interface World {
  customer: CustomerDto;
  supplier: SupplierDto;
  airline: AirlineDto;
  cash: MoneyAccountDto;
}

export async function world(env: TestEnv, s: string, opts: { customerName?: string; supplierName?: string } = {}): Promise<World> {
  const customer = await ok<CustomerDto>(env, 'customers.create', { customer: { fullName: opts.customerName ?? 'Ahmed Ali', primaryMobile: '01001234567' }, confirmDuplicates: true }, s);
  const supplier = await ok<SupplierDto>(env, 'suppliers.create', { supplier: { name: opts.supplierName ?? 'Company ABC', defaultCurrencyCode: 'EGP' }, confirmDuplicates: true }, s);
  const airlines = await ok<{ items: AirlineDto[] }>(env, 'airlines.list', { query: 'MS' }, s);
  const airline = airlines.items.find((a) => a.iataCode === 'MS') ?? await ok<AirlineDto>(env, 'airlines.create', { airline: { nameEn: 'EgyptAir', iataCode: 'MS', ticketPrefix: '077' } }, s);
  const cash = (await ok<MoneyAccountDto[]>(env, 'moneyAccounts.list', {}, s)).find((a) => a.currencyCode === 'EGP')!;
  return { customer, supplier, airline, cash };
}

export const seg = (airlineId: string, over: Record<string, unknown> = {}) => ({
  airlineId, flightNumber: '915', origin: 'CAI', destination: 'JED', departureDate: '2026-10-15', departureTime: '10:00', arrivalDate: '2026-10-15', arrivalTime: '12:30', ...over,
});

export interface BookOpts {
  saleMinor?: number;
  taxesMinor?: number;
  costMinor?: number;
  passengers?: { givenName: string; surname: string; paxType?: 'ADT' | 'CHD' | 'INF' }[];
  segments?: Record<string, unknown>[];
  saleCurrency?: string;
  costCurrency?: string;
  discountMinor?: number;
  issue?: boolean;
  supplierId?: string;
  ticketNumbers?: string[];
}

/** Customer → passengers → booking → segments → pricing → issue, through the public commands. */
export async function book(env: TestEnv, s: string, w: World, o: BookOpts = {}): Promise<BookingDto> {
  let b = await ok<BookingDto>(env, 'bookings.create', { customerId: w.customer.id, pnr: 'ABC123', supplierId: o.supplierId ?? w.supplier.id, saleCurrency: o.saleCurrency ?? null }, s);
  for (const p of o.passengers ?? [{ givenName: 'Ahmed', surname: 'Ali' }]) {
    b = await ok<BookingDto>(env, 'bookings.savePassenger', { bookingId: b.id, passenger: p }, s);
  }
  for (const sg of o.segments ?? [seg(w.airline.id)]) {
    b = await ok<BookingDto>(env, 'bookings.saveSegment', { bookingId: b.id, segment: sg }, s);
  }
  const n = b.passengers.length;
  for (const [i, p] of b.passengers.entries()) {
    b = await ok<BookingDto>(env, 'bookings.savePriceItem', {
      bookingId: b.id,
      item: {
        passengerId: p.id, supplierId: o.supplierId ?? w.supplier.id, fareMinor: (o.saleMinor ?? 1_050_000) / n - (o.taxesMinor ?? 0) / n, taxesMinor: (o.taxesMinor ?? 0) / n,
        discountMinor: o.discountMinor ?? 0, costMinor: (o.costMinor ?? 1_010_000) / n, costCurrency: o.costCurrency ?? o.saleCurrency ?? 'EGP',
        ticketNumber: o.ticketNumbers?.[i] ?? null,
      },
    }, s);
  }
  if (o.issue === false) return b;
  return ok<BookingDto>(env, 'bookings.issue', { id: b.id, rowVersion: b.rowVersion }, s);
}

export async function receive(env: TestEnv, s: string, w: World, bookingId: string, amountMinor: number, extra: Record<string, unknown> = {}): Promise<DocumentDto> {
  return ok<DocumentDto>(env, 'payments.receive', {
    partyId: w.customer.id, currency: 'EGP', amountMinor, moneyAccountId: w.cash.id, paymentMethod: 'CASH', allocations: [{ bookingId, amountMinor }], ...extra,
  }, s);
}

export async function paySupplier(env: TestEnv, s: string, w: World, bookingId: string, amountMinor: number): Promise<DocumentDto> {
  return ok<DocumentDto>(env, 'payments.paySupplier', {
    partyId: w.supplier.id, currency: 'EGP', amountMinor, moneyAccountId: w.cash.id, paymentMethod: 'BANK_TRANSFER', reference: 'TRX-1', allocations: [{ bookingId, amountMinor }],
  }, s);
}

export const summary = (env: TestEnv) => env.backend.svc.ledger.computeSummary('2000-01-01', '2100-12-31');
