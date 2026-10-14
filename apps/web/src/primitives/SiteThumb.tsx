/**
 * A site thumbnail. CommonForge cannot screenshot a live site or a token-gated preview (the CSP is
 * 'self' and previews run on their own origin), so this is the mockup's skeleton of a page:
 * decorative, `aria-hidden`; the text next to it says what it stands for.
 */
export function SiteThumb({ size = "hero", accent = false, tone = "plain" }: { size?: "hero" | "card" | "mini"; /** mint call-to-action bar (the live version) */ accent?: boolean; /** "after": the updated page, a second row of content */ tone?: "plain" | "after" }) {
  if (size !== "hero") {
    return (
      <div className={`site-thumb site-thumb-${size}`} aria-hidden="true">
        <div className="st-bar st-w40" />
        <div className="st-block" />
        {tone === "after" ? <div className="st-line st-w55" /> : null}
        <div className={`st-cta ${accent ? "st-cta-accent" : ""}`} />
      </div>
    );
  }
  return (
    <div className="site-thumb site-thumb-hero" aria-hidden="true">
      <div className="st-dots">
        <span />
        <span />
        <span />
      </div>
      <div className="st-bar st-w40" />
      <div className="st-cols">
        <div className="st-tile" />
        <div className="st-tile" />
      </div>
      <div className="st-line st-w70" />
      <div className="st-line st-w55" />
      {tone === "after" ? <div className="st-line st-w40 st-new" /> : null}
      <div className={`st-cta st-cta-lg ${accent ? "st-cta-accent" : ""}`} />
    </div>
  );
}
