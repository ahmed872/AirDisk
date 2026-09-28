import type { AirlineDto, CurrencyDto, CustomerDto, PageDto, PartyBalanceDto, SupplierDto } from '@airdesk/contracts';
import { call } from '../api';
import { Alert, useLoader, type FieldDef } from '../components';
import { useI18n } from '../i18n';
import { useFmt } from '../prefs';
import { MasterDataPage, type MasterConfig } from './masterdata';

type Can = (p: string) => boolean;

function Balances({ balances }: { balances: PartyBalanceDto[] }) {
  const { t } = useI18n();
  const { money } = useFmt();
  return (
    <section className="subsection" data-testid="balances">
      <h3>{t('balance')}</h3>
      <p className="hint">{t('balanceHint')}</p>
      {balances.length === 0 ? <p className="muted">{t('noBalance')}</p>
        : <ul className="plain">{balances.map((b) => <li key={b.currency} className="ltr">{money(b.balanceMinor, b.currency)}</li>)}</ul>}
    </section>
  );
}

function Audit({ r }: { r: { createdAt: string; updatedAt: string; createdBy?: string | null } }) {
  const { t } = useI18n();
  const { dateTime } = useFmt();
  return (
    <p className="muted small">
      {t('createdAt')}: <span className="ltr">{dateTime(r.createdAt)}</span>
      {r.createdBy ? ` · ${t('createdBy')}: ${r.createdBy}` : ''} · {t('updatedAt')}: <span className="ltr">{dateTime(r.updatedAt)}</span>
    </p>
  );
}

export function CustomersPage({ can }: { can: Can }) {
  const { t } = useI18n();
  const { date } = useFmt();
  const identity = can('customer.view_identity');
  const cfg: MasterConfig<CustomerDto> = {
    entity: 'customers',
    payloadKey: 'customer',
    title: 'navCustomers',
    newLabel: 'newCustomer',
    editLabel: 'editCustomer',
    sort: [{ value: 'customerNo', label: 'number' }, { value: 'fullName', label: 'name' }, { value: 'createdAt', label: 'createdAt' }, { value: 'updatedAt', label: 'updatedAt' }],
    columns: [
      { label: 'number', cell: (r) => r.customerNo, ltr: true },
      { label: 'fullName', cell: (r) => r.fullName },
      { label: 'primaryMobile', cell: (r) => r.primaryMobile, ltr: true },
      { label: 'whatsapp', cell: (r) => r.whatsappNumber ?? '', ltr: true },
      { label: 'email', cell: (r) => r.email ?? '', ltr: true },
      { label: 'createdAt', cell: (r) => date(r.createdAt), ltr: true },
    ],
    defaults: { customerType: 'INDIVIDUAL' },
    fields: (r) => {
      const showIdentity = r ? !r.identityRedacted : identity;
      const defs: FieldDef[] = [
        { name: 'fullName', label: 'fullName', required: true, maxLength: 200 },
        { name: 'fullNameLatin', label: 'fullNameLatin', ltr: true, maxLength: 200 },
        { name: 'customerType', label: 'customerType', kind: 'select', options: [{ value: 'INDIVIDUAL', label: t('individual') }, { value: 'CORPORATE', label: t('corporate') }] },
        { name: 'primaryMobile', label: 'primaryMobile', kind: 'tel', ltr: true, required: true, maxLength: 40 },
        { name: 'secondaryMobile', label: 'secondaryMobile', kind: 'tel', ltr: true, maxLength: 40 },
        { name: 'whatsappNumber', label: 'whatsapp', kind: 'tel', ltr: true, maxLength: 40 },
        { name: 'email', label: 'email', kind: 'email', ltr: true, maxLength: 200 },
        { name: 'nationality', label: 'nationality', ltr: true, maxLength: 2, upper: true },
        { name: 'preferredLocale', label: 'preferredLocale', kind: 'select', options: [{ value: '', label: t('none') }, { value: 'ar', label: 'العربية' }, { value: 'en', label: 'English' }] },
        { name: 'paymentTermsDays', label: 'paymentTerms', kind: 'number', ltr: true },
        { name: 'address', label: 'address', maxLength: 500, wide: true },
      ];
      if (showIdentity) {
        defs.push(
          { name: 'nationalId', label: 'nationalId', ltr: true, maxLength: 40 },
          { name: 'passportNo', label: 'passportNo', ltr: true, maxLength: 20, upper: true },
          { name: 'passportExpiry', label: 'passportExpiry', kind: 'date', ltr: true },
          { name: 'dateOfBirth', label: 'dateOfBirth', kind: 'date', ltr: true },
        );
      }
      defs.push({ name: 'notes', label: 'notes', kind: 'textarea', maxLength: 2000 });
      return defs;
    },
    detail: (r) => (
      <>
        {r.identityRedacted && <Alert kind="info">{t('identityHidden')}</Alert>}
        <Balances balances={r.balances} />
        <Audit r={r} />
      </>
    ),
    perms: { create: can('customer.create'), edit: can('customer.edit'), archive: can('customer.archive') },
  };
  return <MasterDataPage cfg={cfg} />;
}

export function SuppliersPage({ can }: { can: Can }) {
  const { t, locale } = useI18n();
  const currencies = useLoader(() => call<CurrencyDto[]>('currency.list').catch(() => [] as CurrencyDto[]), []);
  const airlines = useLoader(() => (can('airline.view') ? call<PageDto<AirlineDto>>('airlines.list', { limit: 200, sortBy: 'nameEn' }).then((p) => p.items) : Promise.resolve([] as AirlineDto[])), []);
  const cfg: MasterConfig<SupplierDto> = {
    entity: 'suppliers',
    payloadKey: 'supplier',
    title: 'navSuppliers',
    newLabel: 'newSupplier',
    editLabel: 'editSupplier',
    sort: [{ value: 'supplierNo', label: 'number' }, { value: 'name', label: 'name' }, { value: 'createdAt', label: 'createdAt' }, { value: 'updatedAt', label: 'updatedAt' }],
    columns: [
      { label: 'number', cell: (r) => r.supplierNo, ltr: true },
      { label: 'name', cell: (r) => r.name },
      { label: 'contactPerson', cell: (r) => r.contactPerson ?? '' },
      { label: 'phoneNumber', cell: (r) => r.phonePrimary ?? '', ltr: true },
      { label: 'email', cell: (r) => r.email ?? '', ltr: true },
      { label: 'defaultCurrency', cell: (r) => r.defaultCurrencyCode, ltr: true },
    ],
    defaults: { defaultCurrencyCode: (currencies.data ?? []).find((c) => c.isActive)?.code ?? '' },
    fields: (r) => [
      { name: 'name', label: 'name', required: true, maxLength: 200 },
      { name: 'contactPerson', label: 'contactPerson', maxLength: 200 },
      { name: 'phonePrimary', label: 'phoneNumber', kind: 'tel', ltr: true, maxLength: 40 },
      { name: 'phoneSecondary', label: 'phoneSecondary', kind: 'tel', ltr: true, maxLength: 40 },
      { name: 'email', label: 'email', kind: 'email', ltr: true, maxLength: 200 },
      { name: 'countryCode', label: 'country', ltr: true, maxLength: 2, upper: true },
      {
        name: 'defaultCurrencyCode', label: 'defaultCurrency', kind: 'select', required: true,
        options: (currencies.data ?? []).filter((c) => c.isActive || c.code === r?.defaultCurrencyCode).map((c) => ({ value: c.code, label: `${c.code} — ${locale === 'ar' ? c.nameAr : c.nameEn}` })),
      },
      { name: 'paymentTermsDays', label: 'paymentTerms', kind: 'number', ltr: true },
      {
        name: 'airlineId', label: 'linkedAirline', kind: 'select', hint: 'linkedAirlineHint',
        options: [{ value: '', label: t('none') }, ...(airlines.data ?? []).map((a) => ({ value: a.id, label: `${a.iataCode ?? '—'} · ${a.nameEn}` }))],
      },
      { name: 'address', label: 'address', maxLength: 500, wide: true },
      { name: 'notes', label: 'notes', kind: 'textarea', maxLength: 2000 },
    ],
    detail: (r) => (
      <>
        {r.balances ? <Balances balances={r.balances} /> : <Alert kind="info">{t('financialHidden')}</Alert>}
        <Audit r={r} />
      </>
    ),
    perms: { create: can('supplier.create'), edit: can('supplier.edit'), archive: can('supplier.archive') },
  };
  if (currencies.loading) return <div className="page">{t('loading')}</div>;
  return <MasterDataPage cfg={cfg} />;
}

export function AirlinesPage({ can }: { can: Can }) {
  const cfg: MasterConfig<AirlineDto> = {
    entity: 'airlines',
    payloadKey: 'airline',
    title: 'navAirlines',
    newLabel: 'newAirline',
    editLabel: 'editAirline',
    sort: [{ value: 'nameEn', label: 'nameEn' }, { value: 'iataCode', label: 'iataCode' }, { value: 'createdAt', label: 'createdAt' }, { value: 'updatedAt', label: 'updatedAt' }],
    columns: [
      { label: 'iataCode', cell: (r) => r.iataCode ?? '', ltr: true },
      { label: 'icaoCode', cell: (r) => r.icaoCode ?? '', ltr: true },
      { label: 'nameEn', cell: (r) => r.nameEn, ltr: true },
      { label: 'nameAr', cell: (r) => r.nameAr ?? '' },
      { label: 'ticketPrefix', cell: (r) => r.ticketPrefix ?? '', ltr: true },
      { label: 'country', cell: (r) => r.countryCode ?? '', ltr: true },
    ],
    fields: () => [
      { name: 'nameEn', label: 'nameEn', ltr: true, required: true, maxLength: 200 },
      { name: 'nameAr', label: 'nameAr', maxLength: 200 },
      { name: 'iataCode', label: 'iataCode', ltr: true, maxLength: 2, upper: true },
      { name: 'icaoCode', label: 'icaoCode', ltr: true, maxLength: 3, upper: true },
      { name: 'ticketPrefix', label: 'ticketPrefix', ltr: true, maxLength: 3 },
      { name: 'countryCode', label: 'country', ltr: true, maxLength: 2, upper: true },
      { name: 'phone', label: 'phoneNumber', kind: 'tel', ltr: true, maxLength: 40 },
      { name: 'email', label: 'email', kind: 'email', ltr: true, maxLength: 200 },
      { name: 'website', label: 'website', ltr: true, maxLength: 200 },
      { name: 'notes', label: 'notes', kind: 'textarea', maxLength: 2000 },
    ],
    detail: (r) => <Audit r={r} />,
    perms: { create: can('airline.create'), edit: can('airline.edit'), archive: can('airline.archive') },
  };
  return <MasterDataPage cfg={cfg} />;
}
