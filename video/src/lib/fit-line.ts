/** Fitting a text onto one line of fixed width by shrinking its font size. */

export interface FitLineOptions {
  maxWidth: number;
  maxFontSize: number;
  minFontSize: number;
}

export interface FitLine {
  fontSize: number;
  /** True when even `minFontSize` overflows; the caller cuts the line with an ellipsis. */
  ellipsis: boolean;
}

/**
 * The largest font size, at most `maxFontSize`, at which the text fits `maxWidth`. Text width
 * scales linearly with font size, so one measurement at `maxFontSize` decides it.
 */
export function fitLine(widthAtMax: number, o: FitLineOptions): FitLine {
  if (widthAtMax <= o.maxWidth) return { fontSize: o.maxFontSize, ellipsis: false };
  const fontSize = Math.floor((o.maxFontSize * o.maxWidth) / widthAtMax * 10) / 10;
  return fontSize >= o.minFontSize ? { fontSize, ellipsis: false } : { fontSize: o.minFontSize, ellipsis: true };
}
