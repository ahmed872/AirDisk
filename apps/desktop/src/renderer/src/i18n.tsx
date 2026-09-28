import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { OPS, OPS_ERRORS, OPS_REASONS } from './i18n-ops';

/**
 * Typed i18n. Every entry is an [Arabic, English] pair, so a key cannot exist
 * in one language only (compile-time guarantee — no screen ships with a missing
 * translation). Arabic is the primary language.
 */
const BASE = {
  appName: ['AirDesk', 'AirDesk'],
  loading: ['جارٍ التحميل…', 'Loading…'],
  language: ['English', 'العربية'],
  save: ['حفظ', 'Save'],
  saved: ['تم الحفظ', 'Saved'],
  cancel: ['إلغاء', 'Cancel'],
  close: ['إغلاق', 'Close'],
  edit: ['تعديل', 'Edit'],
  details: ['التفاصيل', 'Details'],
  search: ['بحث', 'Search'],
  searchHint: ['ابحث بالاسم أو الموبايل أو واتساب أو البريد أو الرقم', 'Search by name, mobile, WhatsApp, e-mail or number'],
  signIn: ['تسجيل الدخول', 'Sign in'],
  signOut: ['تسجيل الخروج', 'Sign out'],
  username: ['اسم المستخدم', 'Username'],
  password: ['كلمة المرور', 'Password'],
  displayName: ['الاسم الظاهر', 'Display name'],
  confirmPassword: ['تأكيد كلمة المرور', 'Confirm password'],
  passwordsDoNotMatch: ['كلمتا المرور غير متطابقتين', 'Passwords do not match'],
  passwordRule: ['10 أحرف على الأقل، ولا تحتوي على اسم المستخدم', 'At least 10 characters, must not contain the username'],
  setupTitle: ['إعداد الشركة لأول مرة', 'First-time company setup'],
  setupIntro: ['أدخل بيانات شركتك وحساب مدير النظام. لا توجد كلمات مرور افتراضية، وهذه الشاشة تظهر مرة واحدة فقط.', 'Enter your company details and the administrator account. There are no default passwords, and this screen appears only once.'],
  setupStep1: ['الخطوة 1 من 2: الشركة والعملة', 'Step 1 of 2: company & currency'],
  setupStep2: ['الخطوة 2 من 2: مدير النظام', 'Step 2 of 2: administrator'],
  setupDone: ['تم إعداد النظام. سجّل الدخول بحساب مدير النظام.', 'Setup is complete. Sign in with the administrator account.'],
  companySection: ['بيانات الشركة', 'Company'],
  adminSection: ['حساب مدير النظام', 'Administrator account'],
  legalNameAr: ['الاسم القانوني (عربي)', 'Legal name (Arabic)'],
  legalNameEn: ['الاسم القانوني (إنجليزي)', 'Legal name (English)'],
  tradeNameAr: ['الاسم التجاري (عربي)', 'Trade name (Arabic)'],
  tradeNameEn: ['الاسم التجاري (إنجليزي)', 'Trade name (English)'],
  baseCurrency: ['العملة الأساسية', 'Base currency'],
  baseCurrencyHint: ['لا يمكن تغييرها بعد تسجيل أول قيد مالي', 'Cannot be changed after the first financial posting'],
  country: ['الدولة (رمز ISO)', 'Country (ISO code)'],
  timezone: ['المنطقة الزمنية', 'Time zone'],
  defaultLocale: ['اللغة الافتراضية', 'Default language'],
  finishSetup: ['إنهاء الإعداد', 'Finish setup'],
  changePasswordTitle: ['تغيير كلمة المرور', 'Change password'],
  changePasswordIntro: ['يجب تغيير كلمة المرور المؤقتة قبل المتابعة.', 'You must replace your temporary password before continuing.'],
  currentPassword: ['كلمة المرور الحالية', 'Current password'],
  newPassword: ['كلمة المرور الجديدة', 'New password'],

  navDashboard: ['لوحة التحكم', 'Dashboard'],
  navCustomers: ['العملاء', 'Customers'],
  navSuppliers: ['الموردون', 'Suppliers'],
  navAirlines: ['شركات الطيران', 'Airlines'],
  navBookings: ['الحجوزات والتذاكر', 'Bookings & tickets'],
  navFinance: ['المالية', 'Finance'],
  navReports: ['التقارير', 'Reports'],
  navUsers: ['المستخدمون والصلاحيات', 'Users & roles'],
  navCompany: ['إعدادات الشركة', 'Company settings'],
  navAudit: ['سجل التدقيق', 'Audit log'],
  navSystem: ['النسخ الاحتياطي والاستعادة', 'Backup & restore'],
  navMainGroup: ['العمليات', 'Operations'],
  navAdminGroup: ['الإدارة', 'Administration'],
  comingSoon: ['قريبًا', 'Coming soon'],
  comingSoonText: ['هذه الوحدة غير متاحة بعد وستأتي في مرحلة لاحقة. لا توجد أي وظائف تجريبية هنا.', 'This module is not available yet and arrives in a later phase. Nothing on this screen is functional.'],
  welcome: ['مرحبًا', 'Welcome'],
  yourRoles: ['أدوارك', 'Your roles'],
  lastBackup: ['آخر نسخة احتياطية', 'Last backup'],
  never: ['لم تتم بعد', 'Never'],
  activeCount: ['نشط', 'Active'],
  archivedCount: ['مؤرشف', 'Archived'],
  disabledCount: ['موقوف', 'Disabled'],

  phoneNumber: ['الهاتف', 'Phone'],
  phoneSecondary: ['هاتف إضافي', 'Secondary phone'],
  email: ['البريد الإلكتروني', 'E-mail'],
  website: ['الموقع الإلكتروني', 'Website'],
  address: ['العنوان', 'Address'],
  addressAr: ['العنوان (عربي)', 'Address (Arabic)'],
  addressEn: ['العنوان (إنجليزي)', 'Address (English)'],
  taxNumber: ['الرقم الضريبي', 'Tax number'],
  crNumber: ['السجل التجاري', 'Commercial registration'],
  iataAgencyCode: ['رقم الوكالة لدى IATA', 'IATA agency code'],
  invoiceTitleAr: ['عنوان الفاتورة (عربي)', 'Invoice title (Arabic)'],
  invoiceTitleEn: ['عنوان الفاتورة (إنجليزي)', 'Invoice title (English)'],
  invoiceTermsAr: ['شروط الفاتورة (عربي)', 'Invoice terms (Arabic)'],
  invoiceTermsEn: ['شروط الفاتورة (إنجليزي)', 'Invoice terms (English)'],
  footerAr: ['تذييل المستندات (عربي)', 'Document footer (Arabic)'],
  footerEn: ['تذييل المستندات (إنجليزي)', 'Document footer (English)'],
  logo: ['الشعار', 'Logo'],
  logoHint: ['PNG أو JPEG، بحد أقصى 512 كيلوبايت', 'PNG or JPEG, up to 512 KB'],
  removeLogo: ['إزالة الشعار', 'Remove logo'],
  dateFormat: ['تنسيق التاريخ', 'Date format'],
  numberFormat: ['تنسيق الأرقام', 'Number format'],
  numLatin: ['0123456789 (لاتيني)', '0123456789 (Latin)'],
  numArabic: ['٠١٢٣٤٥٦٧٨٩ (عربي هندي)', '٠١٢٣٤٥٦٧٨٩ (Arabic-Indic)'],
  textDirection: ['اتجاه الواجهة', 'Interface direction'],
  dirAuto: ['حسب اللغة', 'Follow language'],
  dirRtl: ['من اليمين لليسار', 'Right to left'],
  dirLtr: ['من اليسار لليمين', 'Left to right'],
  sectionGeneral: ['البيانات العامة والتنسيق', 'General & formats'],
  sectionBranding: ['الهوية والعلامة التجارية', 'Branding'],
  sectionFinancial: ['الإعدادات المالية والفواتير', 'Financial & invoice settings'],
  sectionReadOnly: ['للعرض فقط — ليست لديك صلاحية تعديل هذا القسم', 'Read-only — you cannot edit this section'],
  lockDate: ['تاريخ إقفال الفترة المالية', 'Financial lock date'],
  reason: ['السبب', 'Reason'],

  users: ['المستخدمون', 'Users'],
  roles: ['الأدوار', 'Roles'],
  role: ['الدور', 'Role'],
  active: ['نشط', 'Active'],
  archived: ['مؤرشف', 'Archived'],
  disabled: ['موقوف', 'Disabled'],
  locked: ['مقفل مؤقتًا', 'Temporarily locked'],
  all: ['الكل', 'All'],
  createUser: ['إضافة مستخدم', 'Add user'],
  editUser: ['تعديل المستخدم', 'Edit user'],
  temporaryPassword: ['كلمة مرور مؤقتة', 'Temporary password'],
  temporaryPasswordHint: ['سيُطلب من المستخدم تغييرها عند أول دخول', 'The user must change it at first sign-in'],
  enable: ['تفعيل', 'Enable'],
  disable: ['إيقاف', 'Disable'],
  unlock: ['فك القفل', 'Unlock'],
  resetPassword: ['إعادة تعيين كلمة المرور', 'Reset password'],
  mobile: ['الموبايل', 'Mobile'],
  notes: ['ملاحظات', 'Notes'],
  lastLogin: ['آخر دخول', 'Last login'],
  createdAt: ['تاريخ الإنشاء', 'Created'],
  updatedAt: ['آخر تعديل', 'Last updated'],
  createdBy: ['أنشأه', 'Created by'],
  confirmDisableUser: ['إيقاف هذا المستخدم؟ سيتم إنهاء جلساته فورًا ولن يستطيع الدخول.', 'Disable this user? Their sessions end immediately and they cannot sign in.'],
  newRole: ['دور جديد', 'New role'],
  roleCode: ['رمز الدور', 'Role code'],
  roleCodeHint: ['أحرف إنجليزية كبيرة وأرقام و _ (مثال: TICKETING)', 'Upper-case letters, digits and _ (e.g. TICKETING)'],
  nameAr: ['الاسم (عربي)', 'Name (Arabic)'],
  nameEn: ['الاسم (إنجليزي)', 'Name (English)'],
  description: ['الوصف', 'Description'],
  systemRole: ['دور نظام', 'System role'],
  members: ['المستخدمون في هذا الدور', 'Users in this role'],
  noMembers: ['لا يوجد مستخدمون في هذا الدور', 'No users have this role'],
  permissions: ['الصلاحيات', 'Permissions'],
  savePermissions: ['حفظ الصلاحيات', 'Save permissions'],
  sensitive: ['حساسة', 'Sensitive'],
  adminRoleFixed: ['دور مدير النظام يملك كل الصلاحيات دائمًا ولا يمكن تقليصه', 'The Administrator role always holds every permission'],
  selectRole: ['اختر دورًا لعرض صلاحياته', 'Select a role to see its permissions'],
  assignRolesHint: ['يمكن تعيين أكثر من دور؛ الصلاحيات تُجمع', 'Several roles can be assigned; permissions add up'],
  rename: ['إعادة تسمية', 'Rename'],

  newCustomer: ['عميل جديد', 'New customer'],
  editCustomer: ['بيانات العميل', 'Customer'],
  newSupplier: ['مورد جديد', 'New supplier'],
  editSupplier: ['بيانات المورد', 'Supplier'],
  newAirline: ['شركة طيران جديدة', 'New airline'],
  editAirline: ['بيانات شركة الطيران', 'Airline'],
  number: ['الرقم', 'No.'],
  name: ['الاسم', 'Name'],
  fullName: ['الاسم الكامل', 'Full name'],
  fullNameLatin: ['الاسم بالإنجليزية (كما في الجواز)', 'Name in Latin letters (as in passport)'],
  customerType: ['نوع العميل', 'Customer type'],
  individual: ['فرد', 'Individual'],
  corporate: ['شركة', 'Company'],
  primaryMobile: ['الموبايل الأساسي', 'Primary mobile'],
  secondaryMobile: ['موبايل إضافي', 'Secondary mobile'],
  whatsapp: ['واتساب', 'WhatsApp'],
  nationality: ['الجنسية (رمز ISO)', 'Nationality (ISO code)'],
  nationalId: ['الرقم القومي / الهوية', 'National ID'],
  passportNo: ['رقم الجواز', 'Passport no.'],
  passportExpiry: ['انتهاء الجواز', 'Passport expiry'],
  dateOfBirth: ['تاريخ الميلاد', 'Date of birth'],
  preferredLocale: ['لغة التواصل', 'Preferred language'],
  paymentTerms: ['مدة السداد (أيام)', 'Payment terms (days)'],
  identityHidden: ['بيانات الهوية مخفية — ليست لديك صلاحية عرضها', 'Identity data hidden — you do not have permission to view it'],
  balance: ['الرصيد', 'Balance'],
  balanceHint: ['محسوب من القيود المحاسبية — لا يُعدَّل يدويًا', 'Derived from the journal — never edited by hand'],
  noBalance: ['لا توجد حركات', 'No movements'],
  financialHidden: ['البيانات المالية مخفية — ليست لديك صلاحية عرضها', 'Financial data hidden — you do not have permission to view it'],
  contactPerson: ['مسؤول التواصل', 'Contact person'],
  defaultCurrency: ['العملة الافتراضية', 'Default currency'],
  linkedAirline: ['شركة طيران مرتبطة (اختياري)', 'Linked airline (optional)'],
  linkedAirlineHint: ['المورد جهة مستقلة عن شركة الطيران', 'A supplier is a separate party from the airline'],
  none: ['— لا يوجد —', '— none —'],
  iataCode: ['رمز IATA', 'IATA code'],
  icaoCode: ['رمز ICAO', 'ICAO code'],
  ticketPrefix: ['بادئة التذكرة', 'Ticket prefix'],
  archive: ['أرشفة', 'Archive'],
  restoreRecord: ['إلغاء الأرشفة', 'Restore'],
  confirmArchive: ['أرشفة هذا السجل؟ لن يُحذف ويبقى تاريخه المالي كما هو، ويمكن استرجاعه لاحقًا.', 'Archive this record? It is not deleted, its financial history is kept, and it can be restored later.'],
  archivedReadOnly: ['هذا السجل مؤرشف ولا يمكن تعديله إلا بعد استرجاعه', 'This record is archived; restore it before editing'],
  sortBy: ['ترتيب حسب', 'Sort by'],
  ascending: ['تصاعدي', 'Ascending'],
  descending: ['تنازلي', 'Descending'],
  prev: ['السابق', 'Previous'],
  next: ['التالي', 'Next'],
  showing: ['عرض', 'Showing'],
  of: ['من', 'of'],
  emptyList: ['لا توجد سجلات بعد', 'No records yet'],
  emptySearch: ['لا توجد نتائج مطابقة', 'No matching results'],
  loadFailed: ['تعذر تحميل البيانات', 'Could not load data'],
  retry: ['إعادة المحاولة', 'Retry'],
  duplicateTitle: ['سجلات مشابهة موجودة', 'Similar records exist'],
  duplicateText: ['قد يكون هذا السجل مكررًا. لن يتم دمج أي بيانات تلقائيًا. راجع السجلات التالية ثم قرر.', 'This may be a duplicate. Nothing is merged automatically. Review the records below, then decide.'],
  saveAnyway: ['حفظ كسجل منفصل', 'Save as a separate record'],
  goBack: ['رجوع للتعديل', 'Go back and edit'],
  sig_SAME_PHONE: ['نفس رقم الهاتف', 'Same phone number'],
  sig_SAME_EMAIL: ['نفس البريد الإلكتروني', 'Same e-mail'],
  sig_SIMILAR_NAME_AND_PHONE: ['اسم مشابه ورقم قريب', 'Similar name and phone'],
  sig_SAME_NAME: ['نفس الاسم', 'Same name'],

  status: ['الحالة', 'Status'],
  date: ['التاريخ', 'Date'],
  file: ['الملف', 'File'],
  from: ['من', 'From'],
  to: ['إلى', 'To'],
  user: ['المستخدم', 'User'],
  workstation: ['الجهاز', 'Workstation'],
  action: ['الإجراء', 'Action'],
  entity: ['السجل', 'Record'],
  entityType: ['نوع السجل', 'Record type'],
  before: ['قبل', 'Before'],
  after: ['بعد', 'After'],
  metadata: ['معلومات إضافية', 'Additional info'],
  loadMore: ['تحميل المزيد', 'Load more'],
  apply: ['تطبيق', 'Apply'],
  auditIntro: ['سجل غير قابل للتعديل ومتسلسل بالتجزئة لكل تغيير في النظام', 'Tamper-evident, hash-chained record of every change'],

  backupNow: ['نسخ احتياطي الآن', 'Back up now'],
  backups: ['النسخ الاحتياطية', 'Backups'],
  restore: ['استعادة نسخة', 'Restore a backup'],
  restoreWarning: ['الاستعادة تستبدل كل البيانات الحالية بمحتوى النسخة. سيتم أخذ نسخة أمان تلقائيًا أولًا. اكتب RESTORE للتأكيد.', 'Restore replaces ALL current data with the backup. A safety backup is taken first. Type RESTORE to confirm.'],
  backupFilePath: ['مسار ملف النسخة (.adbk)', 'Backup file path (.adbk)'],
  runIntegrity: ['فحص سلامة البيانات', 'Run integrity check'],
  integrityOk: ['كل الفحوص سليمة', 'All checks passed'],
  integrityFailed: ['يوجد فحص غير سليم', 'Some checks failed'],
  noPermission: ['ليست لديك صلاحية', 'You do not have permission'],
  error: ['خطأ', 'Error'],
  invalidFields: ['راجع الحقول التالية', 'Please check these fields'],

  mod_company: ['الشركة', 'Company'],
  mod_user: ['المستخدمون', 'Users'],
  mod_role: ['الأدوار', 'Roles'],
  mod_customer: ['العملاء', 'Customers'],
  mod_supplier: ['الموردون', 'Suppliers'],
  mod_airline: ['شركات الطيران', 'Airlines'],
  mod_booking: ['الحجوزات', 'Bookings'],
  mod_finance: ['المالية', 'Finance'],
  mod_treasury: ['الخزينة', 'Treasury'],
  mod_report: ['التقارير', 'Reports'],
  mod_system: ['النظام', 'System'],
  mod_other: ['أخرى', 'Other'],
} as const satisfies Record<string, readonly [string, string]>;

const dict = { ...BASE, ...OPS };

/** Backend error codes. */
const errors0 = {
  INVALID_CREDENTIALS: ['اسم المستخدم أو كلمة المرور غير صحيحة', 'Incorrect username or password'],
  ACCOUNT_LOCKED: ['تم قفل الحساب مؤقتًا بسبب محاولات فاشلة متكررة', 'Account temporarily locked after repeated failed attempts'],
  ACCOUNT_DISABLED: ['هذا الحساب موقوف', 'This account is disabled'],
  PASSWORD_POLICY: ['كلمة المرور ضعيفة: 10 أحرف على الأقل ولا تحتوي على اسم المستخدم', 'Weak password: at least 10 characters and must not contain the username'],
  FORBIDDEN: ['ليست لديك صلاحية لهذا الإجراء', 'You do not have permission for this action'],
  UNAUTHENTICATED: ['يجب تسجيل الدخول', 'Please sign in'],
  SESSION_EXPIRED: ['انتهت الجلسة، سجّل الدخول مرة أخرى', 'Your session ended; please sign in again'],
  STALE_RECORD: ['تم تعديل هذا السجل بواسطة مستخدم آخر. أغلق النافذة وأعد فتحه.', 'Someone else changed this record. Close and reopen it.'],
  BASE_CURRENCY_FROZEN: ['لا يمكن تغيير العملة الأساسية بعد وجود قيود مالية', 'The base currency cannot change after financial postings exist'],
  LAST_ADMIN: ['يجب أن يبقى مدير نظام نشط واحد على الأقل', 'At least one active administrator must remain'],
  BACKUP_INVALID: ['ملف النسخة غير صالح أو تالف', 'The backup file is invalid or damaged'],
  VALIDATION: ['البيانات المدخلة غير صحيحة', 'The data entered is not valid'],
  NOT_FOUND: ['السجل غير موجود', 'Record not found'],
  CONFLICT: ['تعارض مع بيانات موجودة', 'Conflicts with existing data'],
  DUPLICATE_WARNING: ['يوجد سجل مشابه', 'A similar record exists'],
  SETUP_ALREADY_DONE: ['تم إعداد النظام من قبل', 'Setup has already been completed'],
  PASSWORD_CHANGE_REQUIRED: ['يجب تغيير كلمة المرور أولًا', 'You must change your password first'],
  INTERNAL: ['حدث خطأ غير متوقع وتم تسجيله', 'An unexpected error occurred and was logged'],
} as const satisfies Record<string, readonly [string, string]>;
const errors = { ...errors0, ...OPS_ERRORS };

/** Domain validation reasons (details.reason). */
const reasons0 = {
  REQUIRED: ['حقل مطلوب', 'is required'],
  TOO_LONG: ['النص أطول من المسموح', 'is too long'],
  INVALID_PHONE: ['رقم هاتف غير صالح', 'is not a valid phone number'],
  INVALID_EMAIL: ['بريد إلكتروني غير صالح', 'is not a valid e-mail address'],
  INVALID_COUNTRY: ['رمز دولة غير صالح (مثال: EG، SA)', 'is not a valid country code (e.g. EG, SA)'],
  INVALID_DATE: ['تاريخ غير صالح', 'is not a valid date'],
  DATE_IN_FUTURE: ['لا يمكن أن يكون في المستقبل', 'cannot be in the future'],
  OUT_OF_RANGE: ['القيمة خارج النطاق المسموح', 'is out of range'],
  INVALID_VALUE: ['قيمة غير صالحة', 'has an invalid value'],
  INVALID_CURRENCY: ['عملة غير معروفة', 'is not a known currency'],
  INVALID_IATA: ['رمز IATA يتكون من حرفين/رقمين (مثال: MS)', 'must be a 2-character IATA code (e.g. MS)'],
  INVALID_ICAO: ['رمز ICAO يتكون من 3 أحرف (مثال: MSR)', 'must be a 3-letter ICAO code (e.g. MSR)'],
  INVALID_TICKET_PREFIX: ['بادئة التذكرة 3 أرقام (مثال: 077)', 'must be 3 digits (e.g. 077)'],
  INVALID_URL: ['رابط غير صالح (يبدأ بـ https://)', 'must be a web address starting with https://'],
  DUPLICATE_CODE: ['الرمز مستخدم لسجل نشط آخر', 'is already used by another active record'],
  DUPLICATE_USERNAME: ['اسم المستخدم مستخدم بالفعل', 'is already taken'],
  ARCHIVED_READ_ONLY: ['السجل مؤرشف ولا يمكن تعديله', 'The record is archived and cannot be edited'],
  ALREADY_ARCHIVED: ['السجل مؤرشف بالفعل', 'The record is already archived'],
  ALREADY_ACTIVE: ['السجل نشط بالفعل', 'The record is already active'],
  ALREADY_DISABLED: ['المستخدم موقوف بالفعل', 'The user is already disabled'],
  NOT_LOCKED: ['الحساب غير مقفل', 'The account is not locked'],
  SELF_LOCKOUT: ['لا يمكنك إيقاف حسابك أو إزالة صلاحية المدير عن نفسك', 'You cannot disable yourself or remove your own administrator role'],
  ESCALATION: ['لا يمكنك منح صلاحيات أو أدوار لا تملكها', 'You cannot grant permissions or roles you do not hold yourself'],
  ADMIN_ROLE_FIXED: ['دور مدير النظام يملك كل الصلاحيات دائمًا', 'The Administrator role always holds every permission'],
  UNKNOWN_ROLE: ['دور غير معروف', 'is an unknown role'],
} as const satisfies Record<string, readonly [string, string]>;
const reasons = { ...reasons0, ...OPS_REASONS };

/** Field names used in error details → labels. */
const fields: Record<string, keyof typeof dict> = {
  fullName: 'fullName', fullNameLatin: 'fullNameLatin', primaryMobile: 'primaryMobile', secondaryMobile: 'secondaryMobile',
  whatsappNumber: 'whatsapp', email: 'email', address: 'address', nationality: 'nationality', nationalId: 'nationalId',
  passportNo: 'passportNo', passportExpiry: 'passportExpiry', dateOfBirth: 'dateOfBirth', paymentTermsDays: 'paymentTerms',
  customerType: 'customerType', notes: 'notes', name: 'name', contactPerson: 'contactPerson', phonePrimary: 'phoneNumber',
  phoneSecondary: 'phoneSecondary', countryCode: 'country', defaultCurrencyCode: 'defaultCurrency', airlineId: 'linkedAirline',
  nameEn: 'nameEn', nameAr: 'nameAr', iataCode: 'iataCode', icaoCode: 'icaoCode', ticketPrefix: 'ticketPrefix', phone: 'phoneNumber',
  website: 'website', username: 'username', displayName: 'displayName', mobile: 'mobile', password: 'password',
  newPassword: 'newPassword', code: 'roleCode', legalNameAr: 'legalNameAr', legalNameEn: 'legalNameEn',
  defaultCountryCode: 'country', baseCurrencyCode: 'baseCurrency', timezone: 'timezone',
  givenName: 'givenName', surname: 'surname', flightNumber: 'flightNumber', origin: 'origin', destination: 'destination',
  departureDate: 'departureDate', departureTime: 'departureTime', arrivalDate: 'arrivalDate', arrivalTime: 'arrivalTime', pnr: 'pnr',
  ticketNumber: 'ticketNumber', passengerId: 'passenger', supplierId: 'supplierSource', costCurrency: 'costCurrency', costMinor: 'purchaseCost',
  fareMinor: 'fare', discountMinor: 'discount', amountMinor: 'amount', allocations: 'allocateTo', moneyAccountId: 'moneyAccount',
  bookingClass: 'bookingClassLabel', contactName: 'contactName', contactMobile: 'contactMobile', reason: 'reason',
  ticketIds: 'tickets', lines: 'tickets', frequentFlyerNo: 'frequentFlyer', iata: 'iataCode', accountCode: 'ledgerAccount',
};

export type Locale = 'ar' | 'en';
export type TKey = keyof typeof dict;
const idx = (l: Locale) => (l === 'ar' ? 0 : 1);

export interface FieldIssue {
  field: string;
  message: string;
}

interface I18n {
  locale: Locale;
  setLocale(l: Locale): void;
  t(key: TKey): string;
  /** Label for a backend field name, or the name itself. */
  fieldLabel(field: string): string;
  /** One human sentence for any error (translated code/reason). */
  errorMessage(e: unknown): string;
  /** Per-field messages extracted from a validation error. */
  fieldIssues(e: unknown): FieldIssue[];
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initial);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18n>(() => {
    const i = idx(locale);
    const t = (k: TKey) => dict[k][i];
    const fieldLabel = (f: string) => {
      const last = f.split('.').pop() ?? f;
      const k = fields[last];
      return k ? t(k) : last;
    };
    const fieldIssues = (e: unknown): FieldIssue[] => {
      const d = (e as { details?: Record<string, unknown> }).details;
      if (!d) return [];
      if (typeof d.field === 'string' && typeof d.reason === 'string') {
        const r = reasons[d.reason as keyof typeof reasons];
        return [{ field: d.field, message: r ? r[i] : String(d.reason) }];
      }
      if (Array.isArray(d.issues)) {
        return (d.issues as { path: string; message: string }[]).map((x) => ({
          field: x.path.split('.').pop() ?? x.path,
          message: locale === 'ar' ? 'قيمة غير صالحة' : x.message,
        }));
      }
      return [];
    };
    const errorMessage = (e: unknown) => {
      const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
      const reason = err.details?.reason as keyof typeof reasons | undefined;
      const field = err.details?.field as string | undefined;
      if (reason && reasons[reason]) return field ? `${fieldLabel(field)}: ${reasons[reason][i]}` : reasons[reason][i];
      const issues = fieldIssues(e);
      if (err.code === 'VALIDATION' && issues.length) return `${t('invalidFields')}: ${issues.map((x) => fieldLabel(x.field)).join('، ')}`;
      const known = err.code ? errors[err.code as keyof typeof errors] : undefined;
      return known ? known[i] : err.message || t('error');
    };
    return { locale, setLocale, t, fieldLabel, errorMessage, fieldIssues };
  }, [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}

export function isTKey(k: string): k is TKey {
  return k in dict;
}
