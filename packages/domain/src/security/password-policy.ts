import { DomainError, ErrorCode } from '../errors';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Small offline deny-list; long passphrases are encouraged (NIST 800-63B, no composition rules). */
const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '0123456789', '12345678910', 'qwertyuiop', 'qwerty1234',
  'admin12345', 'administrator', 'letmein123', 'iloveyou12', 'welcome123', 'abcdefghij', 'asdfghjkl1', 'airdesk123',
  '1111111111', '0000000000', '1q2w3e4r5t', 'zaq12wsxcde',
]);

export function assertPasswordPolicy(password: string, username: string): void {
  const fail = (reason: string) => {
    throw new DomainError(ErrorCode.PASSWORD_POLICY, reason, { reason });
  };
  if (password.length < PASSWORD_MIN_LENGTH) fail(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH) fail(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  const lower = password.toLowerCase();
  if (username && lower.includes(username.toLowerCase())) fail('Password must not contain the username');
  if (COMMON.has(lower)) fail('Password is too common');
  if (new Set(password).size < 4) fail('Password is too repetitive');
}
