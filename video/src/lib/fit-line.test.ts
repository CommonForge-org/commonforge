import { describe, expect, it } from 'vitest';
import { fitLine } from './fit-line';

const options = { maxWidth: 1544, maxFontSize: 30, minFontSize: 20 };

describe('fitLine', () => {
  it('keeps the largest size when the text already fits', () => {
    expect(fitLine(1200, options)).toEqual({ fontSize: 30, ellipsis: false });
  });

  it('shrinks the font in proportion until the text fits the width', () => {
    const fit = fitLine(2000, options);
    expect(fit.ellipsis).toBe(false);
    expect(fit.fontSize).toBeLessThan(30);
    expect((2000 * fit.fontSize) / 30).toBeLessThanOrEqual(1544);
  });

  it('stops at the minimum size and asks for an ellipsis when it still overflows', () => {
    expect(fitLine(4000, options)).toEqual({ fontSize: 20, ellipsis: true });
  });
});
