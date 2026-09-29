/**
 * Code-signing configuration for Windows release builds (docs/product/deployment-and-release.md §7).
 *
 * Nothing secret lives in the repository. Signing is enabled only through the
 * environment of the protected release workflow:
 *
 *   Certificate file (OV/EV exported to PFX, or a PFX provided by the CA):
 *     WIN_CSC_LINK (or CSC_LINK)            path / base64 / https URL of the .pfx
 *     WIN_CSC_KEY_PASSWORD (or CSC_KEY_PASSWORD)
 *   Azure Trusted Signing (cloud HSM, no key file):
 *     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
 *     AIRDESK_AZURE_SIGNING_ENDPOINT, AIRDESK_AZURE_SIGNING_ACCOUNT, AIRDESK_AZURE_CERT_PROFILE
 *
 * AIRDESK_REQUIRE_SIGNING=1 turns a missing credential into a hard failure, so
 * a release can never silently ship unsigned. Local/CI builds without it stay
 * unsigned (and say so).
 */
export function signingMode(env = process.env) {
  const pfx = env.WIN_CSC_LINK || env.CSC_LINK;
  const pfxPassword = env.WIN_CSC_KEY_PASSWORD || env.CSC_KEY_PASSWORD;
  const azureKeys = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AIRDESK_AZURE_SIGNING_ENDPOINT', 'AIRDESK_AZURE_SIGNING_ACCOUNT', 'AIRDESK_AZURE_CERT_PROFILE'];
  const azurePresent = azureKeys.filter((k) => env[k]);
  if (pfx && azurePresent.length) return { mode: 'error', message: 'Both a PFX certificate and Azure Trusted Signing are configured; choose one.' };
  if (pfx) return pfxPassword ? { mode: 'pfx' } : { mode: 'error', message: 'WIN_CSC_LINK is set but WIN_CSC_KEY_PASSWORD is missing.' };
  if (azurePresent.length === azureKeys.length) return { mode: 'azure' };
  if (azurePresent.length) return { mode: 'error', message: `Azure Trusted Signing is partly configured; missing: ${azureKeys.filter((k) => !env[k]).join(', ')}` };
  return { mode: 'unsigned' };
}

export function checkSigning(env = process.env) {
  const required = env.AIRDESK_REQUIRE_SIGNING === '1';
  const m = signingMode(env);
  if (m.mode === 'error') return { ok: false, message: `Signing misconfigured: ${m.message}` };
  if (m.mode === 'unsigned' && required) {
    return { ok: false, message: 'AIRDESK_REQUIRE_SIGNING=1 but no signing credentials were provided (WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD, or Azure Trusted Signing). Refusing to build an unsigned release.' };
  }
  return { ok: true, mode: m.mode, message: m.mode === 'unsigned' ? 'Building UNSIGNED (development/CI build — not for distribution).' : `Signing with ${m.mode}.` };
}

// CLI: node scripts/signing.mjs  → exit 1 with a clear message when signing is required but impossible.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('signing.mjs')) {
  const r = checkSigning();
  console.log(r.message);
  process.exit(r.ok ? 0 : 1);
}
