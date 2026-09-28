import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

export type IdGenerator = () => string;

/**
 * Monotonic ULID generator (26 chars: 48-bit ms timestamp + 80-bit random).
 * Within the same millisecond the random part is incremented, so IDs created
 * in one transaction sort in creation order.
 */
export function createUlidGenerator(now: () => number = Date.now): IdGenerator {
  let lastTime = -1;
  let lastRandom: number[] = [];

  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      // increment 80-bit random (16 base32 digits), carrying
      let i = lastRandom.length - 1;
      while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
      if (i < 0) throw new Error('ULID random overflow within one millisecond');
      lastRandom[i]!++;
    } else {
      lastTime = time;
      const bytes = randomBytes(16);
      lastRandom = Array.from(bytes, (b) => b & 31);
    }
    let timePart = '';
    let t = time;
    for (let i = 0; i < 10; i++) {
      timePart = ENCODING[t % 32] + timePart;
      t = Math.floor(t / 32);
    }
    return timePart + lastRandom.map((d) => ENCODING[d]).join('');
  };
}
