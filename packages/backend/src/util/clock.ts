export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests; advance() simulates time passing. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: string | Date = '2026-09-28T09:00:00.000Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(instant: string | Date): void {
    this.current = new Date(instant).getTime();
  }
}

export const iso = (clock: Clock): string => clock.now().toISOString();
