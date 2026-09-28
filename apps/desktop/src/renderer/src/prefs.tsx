import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { CompanyProfileDto } from '@airdesk/contracts';
import { useI18n } from './i18n';

/**
 * Company display preferences (Phase 2): date format, digit style and the
 * interface direction. They affect presentation only — stored values stay
 * ISO dates and Latin digits.
 */
export type DisplayPrefs = Pick<CompanyProfileDto, 'dateFormat' | 'numberFormat' | 'textDirection' | 'timezone' | 'baseCurrencyCode'>;

export const DEFAULT_PREFS: DisplayPrefs = { dateFormat: 'DD/MM/YYYY', numberFormat: 'LATIN', textDirection: 'AUTO', timezone: 'UTC', baseCurrencyCode: '' };

interface Fmt {
  prefs: DisplayPrefs;
  digits(s: string | number): string;
  date(iso: string | null | undefined): string;
  dateTime(iso: string | null | undefined): string;
  money(minor: number, currency: string, minorUnit?: number): string;
}

const Ctx = createContext<Fmt | null>(null);
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function PrefsProvider({ prefs, children }: { prefs: DisplayPrefs; children: ReactNode }) {
  const { locale } = useI18n();
  const dir = prefs.textDirection === 'AUTO' ? (locale === 'ar' ? 'rtl' : 'ltr') : prefs.textDirection.toLowerCase();
  useEffect(() => {
    document.documentElement.dir = dir;
  }, [dir]);
  const value = useMemo<Fmt>(() => {
    const digits = (s: string | number) => (prefs.numberFormat === 'ARABIC_INDIC' ? String(s).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]!) : String(s));
    const parts = (iso: string, withTime: boolean) => {
      const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
      if (Number.isNaN(d.getTime())) return null;
      let tz = prefs.timezone;
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
      } catch {
        tz = 'UTC';
      }
      const f = new Intl.DateTimeFormat('en-US', {
        timeZone: iso.length === 10 ? 'UTC' : tz, year: 'numeric', month: '2-digit', day: '2-digit',
        ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
      });
      const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
      return p as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;
    };
    const ymd = (p: Record<'year' | 'month' | 'day', string>) =>
      prefs.dateFormat === 'YYYY-MM-DD' ? `${p.year}-${p.month}-${p.day}` : prefs.dateFormat === 'MM/DD/YYYY' ? `${p.month}/${p.day}/${p.year}` : `${p.day}/${p.month}/${p.year}`;
    return {
      prefs,
      digits,
      date: (iso) => {
        if (!iso) return '';
        const p = parts(iso, false);
        return p ? digits(ymd(p)) : iso;
      },
      dateTime: (iso) => {
        if (!iso) return '';
        const p = parts(iso, true);
        return p ? digits(`${ymd(p)} ${p.hour}:${p.minute}`) : iso;
      },
      money: (minor, currency, minorUnit = 2) => {
        const n = new Intl.NumberFormat('en-US', { minimumFractionDigits: minorUnit, maximumFractionDigits: minorUnit }).format(minor / 10 ** minorUnit);
        return `${digits(n)} ${currency}`;
      },
    };
  }, [prefs]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFmt(): Fmt {
  const v = useContext(Ctx);
  if (!v) throw new Error('PrefsProvider missing');
  return v;
}
