import type { Listing, TenureValue } from "@/lib/types";
import { PLACEHOLDER_IMAGE_DATA_URI } from "@/lib/placeholderImage";

const TENURE_LABELS: Record<TenureValue, string> = {
  share_of_freehold: "Share of freehold",
  leasehold: "Leasehold",
  freehold: "Freehold",
  shared_ownership: "Shared ownership",
};

export default function ListingsGrid({ listings }: { listings: Listing[] }) {
  if (listings.length === 0) {
    return (
      <p className="listings-empty">
        No homes match your filters. Try widening your search or clearing filters.
      </p>
    );
  }

  return (
    <div className="listing-grid">
      {listings.map((l) => (
        <a
          key={`${l.sourceId}-${l.externalId}`}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          className="listing-card"
        >
          <div className="listing-card__image-wrap">
            <img
              src={l.mainImage ?? PLACEHOLDER_IMAGE_DATA_URI}
              alt={l.title}
              className="listing-card__image"
              loading="lazy"
            />
            {l.isNewBuild && <span className="listing-card__badge">New build</span>}
          </div>
          <div className="listing-card__body">
            <div className="listing-card__price">{l.price}</div>
            <div className="listing-card__title">{l.title}</div>
            <div className="listing-card__meta">
              <span>
                {l.bedrooms === null ? "Bedrooms not stated" : l.bedrooms === 0 ? "Studio" : `${l.bedrooms} bed`}
              </span>
              {l.bedroomType && (
                <span>· {l.bedroomType === "single" ? "Single" : "Double"} bed</span>
              )}
              <span>· {l.tenure ? TENURE_LABELS[l.tenure] : "Tenure not stated"}</span>
            </div>
            <div className="listing-card__footer">
              <span className="listing-card__area">
                {l.area}
                {l.postcode ? ` · ${l.postcode}` : ""}
              </span>
              <span className="listing-card__source">{l.sourceName}</span>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
