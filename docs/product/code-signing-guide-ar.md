# دليل الحصول على شهادة توقيع الكود (Code Signing) لـ AirDesk

<div dir="rtl">

## ليه محتاجين الشهادة؟
- ويندوز بيعرض تحذير "Windows protected your PC / ناشر غير معروف" لأي برنامج غير موقَّع، وبعض برامج الحماية بتحجزه.
- التوقيع بيثبت إن الملف جاي منك ومتعدّلش بعد ما خرج من عندك.
- المشروع جاهز للتوقيع بالكامل. الناقص فقط الشهادة نفسها، وده شيء لازم تشتريه أنت باسم شركتك.

## الاختيار الأول (الأسهل والأرخص عادةً): Azure Trusted Signing من مايكروسوفت
مناسب لو عندك شركة مسجّلة، وغالبًا لا يحتاج أي جهاز USB.

1. اعمل حساب على **Azure** (portal.azure.com) باسم الشركة، وفعّل الدفع (Pay-As-You-Go).
2. من البحث اكتب **Trusted Signing** ← **Create** لإنشاء **Trusted Signing Account**. اختر منطقة، مثلًا West Europe، وخطة Basic.
3. داخل الحساب: **Identity validation** ← **New identity** ← نوع **Public** ← **Organization**. ادخل بيانات الشركة **مطابقة للسجل التجاري**: الاسم القانوني، العنوان، الرقم الضريبي، والموقع/الدومين إن وُجد.
   - مايكروسوفت بتراجع البيانات، وقد تطلب مستندات: سجل تجاري أو خطاب رسمي. المراجعة بتاخد من أيام لأسابيع.
   - **ملاحظة مهمة:** الخدمة عند فتحها كانت متاحة لشركات في دول معيّنة (أمريكا، كندا، أوروبا، والمملكة المتحدة). تأكّد من دولة تسجيل شركتك على صفحة الخدمة. لو غير متاحة، استخدم الاختيار الثاني.
4. بعد الموافقة: **Certificate profiles** ← **Create** ← **Public Trust** ← اختر الـ identity. اسم الـ profile مثلًا `airdesk-release`.
5. أنشئ **App registration** في Microsoft Entra ID، وهو "مستخدم آلي" يوقّع بدل منك:
   - Entra ID ← App registrations ← New ← اسم `airdesk-signing`.
   - Certificates & secrets ← **New client secret** ← انسخ القيمة فورًا، لأنها لا تظهر مرة أخرى.
   - ارجع لحساب Trusted Signing ← **Access control (IAM)** ← Add role assignment ← **Trusted Signing Certificate Profile Signer** ← اختر `airdesk-signing`.
6. خُد البيانات دي، وهتحطها في GitHub (الخطوة الأخيرة تحت):

| القيمة | من فين | اسمها في GitHub |
|---|---|---|
| Tenant ID | صفحة App registration | secret: `AZURE_TENANT_ID` |
| Client ID | صفحة App registration | secret: `AZURE_CLIENT_ID` |
| Client secret | الخطوة 5 | secret: `AZURE_CLIENT_SECRET` |
| Endpoint | صفحة حساب Trusted Signing، مثل `https://weu.codesigning.azure.net` | variable: `AIRDESK_AZURE_SIGNING_ENDPOINT` |
| اسم الحساب | حساب Trusted Signing | variable: `AIRDESK_AZURE_SIGNING_ACCOUNT` |
| اسم الـ profile | الخطوة 4 | variable: `AIRDESK_AZURE_CERT_PROFILE` |
| اسم الناشر كما سيظهر للمستخدم | الاسم القانوني للشركة | variable: `AIRDESK_PUBLISHER_NAME` |

## الاختيار الثاني: شهادة OV أو EV من جهة إصدار (CA)
الجهات المعروفة: DigiCert، Sectigo، GlobalSign، SSL.com، Certum.

- **OV (Organization Validation):** أرخص. في الأول قد يظهر تحذير SmartScreen لحد ما البرنامج ياخد "سمعة" مع التحميلات.
- **EV (Extended Validation):** أغلى. تحقق أشد، وسمعة أفضل من البداية.

الخطوات:
1. اختر الجهة، واطلب **Code Signing Certificate** (OV أو EV) باسم الشركة القانوني.
2. جهّز المستندات:
   - السجل التجاري؛
   - إثبات العنوان؛
   - رقم تليفون الشركة يكون مسجّل في دليل عام أو على خطاب رسمي، لأنهم بيتصلوا للتحقق؛
   - وأحيانًا خطاب من محامٍ أو محاسب.
3. منذ يونيو 2023 المفتاح الخاص لازم يكون على **جهاز USB (توكن)** أو **خدمة توقيع سحابية** من نفس الجهة، زي DigiCert KeyLocker أو SSL.com eSigner. للتوقيع الآلي من GitHub اختار **الخدمة السحابية**، لأن التوكن محتاج يكون متوصّل بجهاز.
4. لو الجهة بتسمح بملف **PFX** (نادر الآن)، أو عندك ملف PFX من خدمة سحابية تدعمه:
   - `WIN_CSC_LINK`: محتوى الملف بصيغة base64. في PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`
   - `WIN_CSC_KEY_PASSWORD`: كلمة سر الملف.
   - لو الجهة أعطتك أداة توقيع سحابية بدل PFX، ابعتلي اسم الخدمة وأنا أضبط خطوة التوقيع عليها.

## الخطوة الأخيرة: وضع البيانات في GitHub (مرة واحدة)
1. في مستودع AirDisk على GitHub: **Settings ← Environments ← New environment** باسم `release`.
2. فعّل **Required reviewers** وأضف نفسك، علشان أي إصدار يحتاج موافقتك.
3. في نفس الـ environment أضف الـ **Secrets** والـ **Variables** من الجدول (Azure) أو `WIN_CSC_LINK` و`WIN_CSC_KEY_PASSWORD` (PFX). لا تضع الاثنين معًا.
4. اختياري: variable باسم `AIRDESK_SIGNER_SUBJECT` = اسم الشركة كما يظهر في الشهادة، مثل `CN=Horizon Travel LLC`. سكربت التحقق هيرفض أي توقيع باسم مختلف.

**ممنوع** رفع ملف الشهادة أو كلمة سرها داخل المستودع. المستودع يمنع ملفات `.pfx`، ولا تُكتب القيم في أي ملف أو رسالة.

## التجربة
- في GitHub: **Actions ← Release (signed Windows installer) ← Run workflow**.
- لو ناقص أي بيانات، الـ workflow **يفشل برسالة واضحة**، ولا يطلع مثبّت غير موقّع.
- لو نجح: هتلاقي Artifact فيه `AirDesk-Setup-<version>-x64.exe` و`SHA256SUMS.txt`. على جهاز ويندوز: كليك يمين على الملف ← Properties ← Digital Signatures، ولازم يظهر اسم شركتك مع وقت التوقيع.

</div>
