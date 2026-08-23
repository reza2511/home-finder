/** The one hero figure on the Statistics page — dataviz's "hero figure"
 * contract: ≥48px, the same sans as the rest of the app, proportional (not
 * tabular) figures, exactly one per view. */
export default function StatsHero({ total }: { total: number }) {
  return (
    <section className="stats-hero">
      <span className="stats-hero__label">Total houses currently listed</span>
      <span className="stats-hero__value">{total.toLocaleString("en-GB")}</span>
    </section>
  );
}
