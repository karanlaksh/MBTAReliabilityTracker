import { describe, expect, it } from 'vitest';
import { serviceDate } from '../src/service-date';

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('serviceDate', () => {
  it('uses the calendar date during normal hours', () => {
    expect(serviceDate(at('2026-08-01T12:00:00-04:00'))).toBe('2026-08-01');
  });

  it('rolls over at 03:00 local, not at midnight', () => {
    expect(serviceDate(at('2026-08-01T02:59:59-04:00'))).toBe('2026-07-31');
    expect(serviceDate(at('2026-08-01T03:00:00-04:00'))).toBe('2026-08-01');
  });

  it('treats midnight as the previous service date', () => {
    expect(serviceDate(at('2026-08-01T00:00:00-04:00'))).toBe('2026-07-31');
  });

  it('crosses month and year boundaries', () => {
    expect(serviceDate(at('2026-08-01T01:00:00-04:00'))).toBe('2026-07-31');
    expect(serviceDate(at('2026-01-01T01:00:00-05:00'))).toBe('2025-12-31');
  });

  it('is correct across spring-forward (2026-03-08, 02:00 local does not exist)', () => {
    expect(serviceDate(at('2026-03-08T01:30:00-05:00'))).toBe('2026-03-07');
    expect(serviceDate(at('2026-03-08T03:30:00-04:00'))).toBe('2026-03-08');
  });

  it('is correct across fall-back (2026-11-01, 01:30 local happens twice)', () => {
    expect(serviceDate(at('2026-11-01T01:30:00-04:00'))).toBe('2026-10-31'); // first pass, EDT
    expect(serviceDate(at('2026-11-01T01:30:00-05:00'))).toBe('2026-10-31'); // second pass, EST
    expect(serviceDate(at('2026-11-01T03:00:00-05:00'))).toBe('2026-11-01');
  });

  it('does not depend on the host machine timezone', () => {
    // Same instant, expressed in UTC. 06:30Z on Aug 1 is 02:30 in Boston.
    expect(serviceDate(at('2026-08-01T06:30:00Z'))).toBe('2026-07-31');
  });
});
