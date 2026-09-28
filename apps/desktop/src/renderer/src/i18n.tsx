import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Minimal typed i18n: the `en` dictionary must have exactly the keys of `ar`
 * (compile-time check), so no screen can ship with a missing translation.
 */
const ar = {
  appName: 'AirDesk',
  loading: 'جارٍ التحميل…',
  language: 'English',
  save: 'حفظ',
  saved: 'تم الحفظ',
  cancel: 'إلغاء',
  signIn: 'تسجيل الدخول',
  signOut: 'تسجيل الخروج',
  username: 'اسم المستخدم',
  password: 'كلمة المرور',
  displayName: 'الاسم الظاهر',
  confirmPassword: 'تأكيد كلمة المرور',
  passwordsDoNotMatch: 'كلمتا المرور غير متطابقتين',
  setupTitle: 'إعداد الشركة لأول مرة',
  setupIntro: 'أدخل بيانات شركتك وحساب مدير النظام. لا توجد كلمات مرور افتراضية.',
  companySection: 'بيانات الشركة',
  adminSection: 'حساب مدير النظام',
  legalNameAr: 'الاسم القانوني (عربي)',
  legalNameEn: 'الاسم القانوني (إنجليزي)',
  baseCurrency: 'العملة الأساسية',
  baseCurrencyHint: 'لا يمكن تغييرها بعد تسجيل أول قيد مالي',
  country: 'رمز الدولة (ISO)',
  timezone: 'المنطقة الزمنية',
  defaultLocale: 'اللغة الافتراضية',
  finishSetup: 'إنهاء الإعداد',
  changePasswordTitle: 'تغيير كلمة المرور',
  changePasswordIntro: 'يجب تغيير كلمة المرور المؤقتة قبل المتابعة.',
  currentPassword: 'كلمة المرور الحالية',
  newPassword: 'كلمة المرور الجديدة',
  navHome: 'الرئيسية',
  navCompany: 'إعدادات الشركة',
  navUsers: 'المستخدمون',
  navSystem: 'النظام والنسخ الاحتياطي',
  welcome: 'مرحبًا',
  homeIntro: 'هذه هي المرحلة الأولى: الأساس التقني. شاشات العملاء والحجوزات والمدفوعات تأتي في المراحل التالية.',
  yourRoles: 'أدوارك',
  phoneNumber: 'الهاتف',
  email: 'البريد الإلكتروني',
  address: 'العنوان',
  taxNumber: 'الرقم الضريبي',
  crNumber: 'السجل التجاري',
  lockDate: 'تاريخ إقفال الفترة المالية',
  users: 'المستخدمون',
  roles: 'الأدوار',
  active: 'نشط',
  disabled: 'موقوف',
  locked: 'مقفل مؤقتًا',
  createUser: 'إضافة مستخدم',
  temporaryPassword: 'كلمة مرور مؤقتة',
  enable: 'تفعيل',
  disable: 'إيقاف',
  backupNow: 'نسخ احتياطي الآن',
  backups: 'النسخ الاحتياطية',
  restore: 'استعادة نسخة',
  restoreWarning: 'الاستعادة تستبدل كل البيانات الحالية بمحتوى النسخة. سيتم أخذ نسخة أمان تلقائيًا أولًا. اكتب RESTORE للتأكيد.',
  backupFilePath: 'مسار ملف النسخة (.adbk)',
  runIntegrity: 'فحص سلامة البيانات',
  integrityOk: 'كل الفحوص سليمة',
  integrityFailed: 'يوجد فحص غير سليم',
  status: 'الحالة',
  date: 'التاريخ',
  file: 'الملف',
  noPermission: 'ليست لديك صلاحية',
  error: 'خطأ',
};

const en: Record<keyof typeof ar, string> = {
  appName: 'AirDesk',
  loading: 'Loading…',
  language: 'العربية',
  save: 'Save',
  saved: 'Saved',
  cancel: 'Cancel',
  signIn: 'Sign in',
  signOut: 'Sign out',
  username: 'Username',
  password: 'Password',
  displayName: 'Display name',
  confirmPassword: 'Confirm password',
  passwordsDoNotMatch: 'Passwords do not match',
  setupTitle: 'First-time company setup',
  setupIntro: 'Enter your company details and the administrator account. There are no default passwords.',
  companySection: 'Company',
  adminSection: 'Administrator account',
  legalNameAr: 'Legal name (Arabic)',
  legalNameEn: 'Legal name (English)',
  baseCurrency: 'Base currency',
  baseCurrencyHint: 'Cannot be changed after the first financial posting',
  country: 'Country code (ISO)',
  timezone: 'Time zone',
  defaultLocale: 'Default language',
  finishSetup: 'Finish setup',
  changePasswordTitle: 'Change password',
  changePasswordIntro: 'You must replace your temporary password before continuing.',
  currentPassword: 'Current password',
  newPassword: 'New password',
  navHome: 'Home',
  navCompany: 'Company settings',
  navUsers: 'Users',
  navSystem: 'System & backup',
  welcome: 'Welcome',
  homeIntro: 'This is Phase 1: the technical foundation. Customers, bookings and payments screens arrive in the next phases.',
  yourRoles: 'Your roles',
  phoneNumber: 'Phone',
  email: 'Email',
  address: 'Address',
  taxNumber: 'Tax number',
  crNumber: 'Commercial registration',
  lockDate: 'Financial lock date',
  users: 'Users',
  roles: 'Roles',
  active: 'Active',
  disabled: 'Disabled',
  locked: 'Temporarily locked',
  createUser: 'Add user',
  temporaryPassword: 'Temporary password',
  enable: 'Enable',
  disable: 'Disable',
  backupNow: 'Back up now',
  backups: 'Backups',
  restore: 'Restore a backup',
  restoreWarning: 'Restore replaces ALL current data with the backup. A safety backup is taken first. Type RESTORE to confirm.',
  backupFilePath: 'Backup file path (.adbk)',
  runIntegrity: 'Run integrity check',
  integrityOk: 'All checks passed',
  integrityFailed: 'Some checks failed',
  status: 'Status',
  date: 'Date',
  file: 'File',
  noPermission: 'You do not have permission',
  error: 'Error',
};

export type Locale = 'ar' | 'en';
export type TKey = keyof typeof ar;
const dictionaries: Record<Locale, Record<TKey, string>> = { ar, en };

/** Translated messages for backend error codes; falls back to the server message. */
const errorText: Record<Locale, Record<string, string>> = {
  ar: {
    INVALID_CREDENTIALS: 'اسم المستخدم أو كلمة المرور غير صحيحة',
    ACCOUNT_LOCKED: 'تم إيقاف الحساب مؤقتًا بسبب محاولات فاشلة متكررة',
    ACCOUNT_DISABLED: 'هذا الحساب موقوف',
    PASSWORD_POLICY: 'كلمة المرور ضعيفة: 10 أحرف على الأقل ولا تحتوي على اسم المستخدم',
    FORBIDDEN: 'ليست لديك صلاحية لهذا الإجراء',
    SESSION_EXPIRED: 'انتهت الجلسة، سجّل الدخول مرة أخرى',
    STALE_RECORD: 'تم تعديل البيانات بواسطة مستخدم آخر، أعد التحميل',
    BASE_CURRENCY_FROZEN: 'لا يمكن تغيير العملة الأساسية بعد وجود قيود مالية',
    LAST_ADMIN: 'يجب أن يبقى مدير نظام نشط واحد على الأقل',
    BACKUP_INVALID: 'ملف النسخة غير صالح أو تالف',
    VALIDATION: 'البيانات المدخلة غير صحيحة',
  },
  en: {},
};

interface I18n {
  locale: Locale;
  setLocale(l: Locale): void;
  t(key: TKey): string;
  errorMessage(e: unknown): string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initial);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);
  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (k) => dictionaries[locale][k],
      errorMessage: (e) => {
        const err = e as { code?: string; message?: string };
        return (err.code && errorText[locale][err.code]) || err.message || dictionaries[locale].error;
      },
    }),
    [locale],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}
