import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM build script without type declarations
import { checkSigning, signingMode } from '../scripts/signing.mjs';

describe('release signing gate', () => {
  it('development builds stay possible without a certificate (and say they are unsigned)', () => {
    expect(checkSigning({})).toMatchObject({ ok: true, mode: 'unsigned' });
  });
  it('a release that requires signing fails clearly without credentials', () => {
    const r = checkSigning({ AIRDESK_REQUIRE_SIGNING: '1' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no signing credentials/);
  });
  it('accepts a PFX only with its password, and a complete Azure Trusted Signing configuration', () => {
    expect(checkSigning({ AIRDESK_REQUIRE_SIGNING: '1', WIN_CSC_LINK: 'cert.pfx' }).ok).toBe(false);
    expect(checkSigning({ AIRDESK_REQUIRE_SIGNING: '1', WIN_CSC_LINK: 'cert.pfx', WIN_CSC_KEY_PASSWORD: 'x' })).toMatchObject({ ok: true, mode: 'pfx' });
    const azure = { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', AIRDESK_AZURE_SIGNING_ENDPOINT: 'https://x', AIRDESK_AZURE_SIGNING_ACCOUNT: 'a', AIRDESK_AZURE_CERT_PROFILE: 'p' };
    expect(signingMode(azure).mode).toBe('azure');
    expect(checkSigning({ AIRDESK_REQUIRE_SIGNING: '1', AZURE_TENANT_ID: 't' }).ok).toBe(false);
    expect(checkSigning({ ...azure, WIN_CSC_LINK: 'x', WIN_CSC_KEY_PASSWORD: 'y' }).ok).toBe(false);
  });
});
