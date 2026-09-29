# VAT and e-invoicing: status and requirements

**Status in 1.0.0-rc.2:** AirDesk does **not** calculate VAT and does **not** submit invoices to any tax authority. It is **not** compliant with Egypt's ETA e-invoice/e-receipt system, Saudi Arabia's ZATCA FATOORA, or the UAE FTA e-invoicing programme, and it must not be described as such.

## 1. What exists today (generic, market-neutral)

| Item | Where |
|---|---|
| Company tax registration number and commercial registration number | Company settings; printed on invoices, receipts and statements |
| Invoice title and terms (Arabic/English), document footer | Company settings (for example "فاتورة" or "فاتورة ضريبية" as the office decides) |
| Gap-free document numbers per type and year | `INV-2026-000001`… allocated inside the posting transaction |
| Immutable documents; corrections only by credit notes and reversals | Financial model §1 |
| `tax_code` table (code, names, rate as a decimal string, `applies_to` SERVICE_FEE / ALL_SALES / PURCHASES) | Schema since migration 1; **not used by any posting rule yet** |
| Separate revenue accounts for fares (4100) and service/change fees (4200), and cancellation fees (4210) | Chart of accounts: the split a VAT-on-fees regime needs |

## 2. Why no VAT calculation was added in this release

Adding VAT changes posting rules. It needs:
- a VAT-payable account (and possibly VAT-receivable);
- a VAT line on invoices and credit notes;
- proportional reversal in cancellations and reissues;
- rounding rules;
- a VAT return report.

The rules differ by market and by the office's status:
- **Egypt:** 14 % on the agency's service fee; international air transport is typically zero-rated or exempt.
- **Saudi Arabia:** 15 %; international transport is zero-rated and domestic flights are standard-rated.
- **UAE:** 5 %.
- Whether the office acts as agent or principal changes the rules again.

The product owner has not decided the target market or the regime. Implementing a guessed regime would change financial semantics without a specification, which the project rules forbid. **This is a business/legal decision (see §4).**

## 3. What each regime needs (to be specified before implementation)

### Egypt: ETA
- VAT (and Table tax where applicable) computed per line with ETA item codes (GS1/EGS). For a travel agency this is typically the service fee; confirm with the tax adviser.
- **E-invoice** (B2B) and **e-receipt** (B2C, POS/e-receipt system) submission to the ETA API:
  - JSON/XML canonical document;
  - **digital signature with a USB token (HSM) issued by an ETA-approved provider** (the token cannot be emulated in software);
  - taxpayer RIN, activity code, branch;
  - UUID and QR (receipts).
- Submission status tracking, rejection handling, cancellation within the allowed window, and credit/debit notes referencing the original UUID.
- Registration of the software/POS with ETA for e-receipts.

### Saudi Arabia: ZATCA FATOORA (Phase 2, integration)
- 15 % VAT; zero-rated international transport; tax invoice vs simplified invoice.
- UBL 2.1 XML with ZATCA extensions, cryptographic stamp, previous-invoice hash chain, invoice counter, and a TLV QR code.
- Onboarding each device/solution:
  - CSR → compliance CSID → compliance checks → production CSID (PCSID);
  - clearance (B2B, real time) or reporting within 24 h (B2C).
- Arabic invoice content requirements, VAT number formats, and credit/debit notes with a reason and reference.

### UAE: FTA
- 5 % VAT; tax invoice content rules.
- The e-invoicing programme (Peppol-based, through accredited service providers) is being phased in. The integration would go through an Accredited Service Provider.

## 4. Decisions needed from the owner (external business/legal requirements)

1. The first target market(s) and whether pilot offices are VAT-registered.
2. The VAT treatment of fares vs service fees for the office's business model (agent vs principal), confirmed in writing by a tax adviser.
3. Whether AirDesk must issue the legal tax invoice itself, or whether the office keeps using an existing e-invoicing system for tax invoices. In that case AirDesk remains the operational and accounting record.
4. For ETA/ZATCA integration: a signing token or certificate (ETA) or ZATCA onboarding credentials (CSID), and a test taxpayer account.

## 5. Safe path once decided

1. Specification of the posting rules:
   - VAT on fees → Dr 1200 / Cr 4200 + Cr 22xx VAT payable;
   - credit notes reverse proportionally.
   These must be reviewed like the Phase 0 financial model, with property tests: documents balance, and VAT payable equals the VAT report.
2. Migration: activate `tax_code`, add the VAT-payable account, and add a VAT line type. Existing documents are not touched (immutable).
3. VAT return report, reconciled to the ledger the same way as the other reports.
4. Market adapter (ETA or ZATCA) as a separate integration with its own outbox, retry and audit, tested against the authority's sandbox.

Until then, sell AirDesk only to offices that either are not VAT-registered or issue their tax invoices elsewhere, and state this in the sales contract.
