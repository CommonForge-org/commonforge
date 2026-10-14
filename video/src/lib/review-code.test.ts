import { describe, expect, it } from 'vitest';
import { shortCode } from './review-code';

describe('shortCode', () => {
  it('shows the first 12 hex characters in groups of four, like the web app', () => {
    expect(shortCode('0123456789abcdef'.repeat(4))).toBe('0123 4567 89ab');
  });

  it('shows anything that is not a real hash unchanged', () => {
    expect(shortCode('PLACEHOLDER-FIXED')).toBe('PLACEHOLDER-FIXED');
  });
});
