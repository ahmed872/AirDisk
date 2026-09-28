import { DomainError, ErrorCode, assertIsoDate, parseRate } from '@airdesk/domain';
import type { CurrencyDto } from '@airdesk/contracts';
import type { CompanyService } from './company-service';
import { actorOf, requirePermission, tx, type Actor, type ServiceDeps } from './context';

/**
 * Currency foundation (BR-CUR-*). Rates are dated, manual (offline-first) and
 * editable with audit; posted documents keep the rate they were posted with,
 * so editing a rate never changes history.
 */
export class CurrencyService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly company: CompanyService,
  ) {}

  list(): CurrencyDto[] {
    return (
      this.deps.db.prepare('SELECT code, name_ar, name_en, symbol, minor_unit, is_active FROM currency ORDER BY code').all() as {
        code: string; name_ar: string; name_en: string; symbol: string | null; minor_unit: number; is_active: number;
      }[]
    ).map((c) => ({ code: c.code, nameAr: c.name_ar, nameEn: c.name_en, symbol: c.symbol, minorUnit: c.minor_unit, isActive: c.is_active === 1 }));
  }

  minorUnitOf(code: string): number {
    const r = this.deps.db.prepare('SELECT minor_unit, is_active FROM currency WHERE code = ?').get(code) as { minor_unit: number; is_active: number } | undefined;
    if (!r || r.is_active !== 1) throw new DomainError(ErrorCode.VALIDATION, `Unknown or inactive currency ${code}`, { code });
    return r.minor_unit;
  }

  setRate(actor: Actor, input: { currencyCode: string; rateDate: string; rate: string }): void {
    requirePermission(this.deps, actor, 'finance.exchange_rates', 'currency.setRate');
    assertIsoDate(input.rateDate, 'rate date');
    const rate = parseRate(input.rate);
    this.minorUnitOf(input.currencyCode);
    if (input.currencyCode === this.company.core().baseCurrency) {
      throw new DomainError(ErrorCode.VALIDATION, 'The base currency always has rate 1');
    }
    tx(this.deps, () => {
      const existing = this.deps.db
        .prepare(`SELECT id, rate FROM exchange_rate WHERE currency_code = ? AND rate_date = ? AND source = 'MANUAL'`)
        .get(input.currencyCode, input.rateDate) as { id: string; rate: string } | undefined;
      const now = this.deps.clock.now().toISOString();
      if (existing) {
        this.deps.db.prepare('UPDATE exchange_rate SET rate = ?, created_at = ?, created_by = ? WHERE id = ?').run(rate, now, actor.userId, existing.id);
      } else {
        this.deps.db
          .prepare(`INSERT INTO exchange_rate (id, currency_code, rate_date, rate, source, created_at, created_by) VALUES (?, ?, ?, ?, 'MANUAL', ?, ?)`)
          .run(this.deps.newId(), input.currencyCode, input.rateDate, rate, now, actor.userId);
      }
      this.deps.audit.append(actorOf(actor), {
        action: existing ? 'rate.updated' : 'rate.created',
        entityType: 'exchange_rate',
        entityId: `${input.currencyCode}:${input.rateDate}`,
        before: existing ? { rate: existing.rate } : undefined,
        after: { rate },
      });
    });
  }

  /** Latest rate on or before the date, or null (callers must then ask the user — never assume 1). */
  rateOn(currencyCode: string, date: string): string | null {
    if (currencyCode === this.company.core().baseCurrency) return '1';
    const r = this.deps.db
      .prepare('SELECT rate FROM exchange_rate WHERE currency_code = ? AND rate_date <= ? ORDER BY rate_date DESC, created_at DESC LIMIT 1')
      .get(currencyCode, date) as { rate: string } | undefined;
    return r?.rate ?? null;
  }
}
