import type { RemovedListing, TenureValue } from "@/lib/types";
import { PLACEHOLDER_IMAGE_DATA_URI } from "@/lib/placeholderImage";
import { formatDateTime } from "@/lib/relativeTime";

const TENURE_LABELS: Record<TenureValue, string> = {
  share_of_freehold: "Share of freehold",
  leasehold: "Leasehold",
  freehold: "Freehold",
  shared_ownership: "Shared ownership",
};

interface Props {
  listings: RemovedListing[];
  emptyMessage?: string;
}

/**
 * Cards for the Removed items page — same visual language as ListingsGrid
 * (components/ListingsGrid.tsx), minus the favourite heart and "New build"
 * badge (neither applies to a listing that's gone), plus a "Removed"
 * date line. A deliberately separate component rather than teaching
 * ListingsGrid an optional removedAt prop: it takes RemovedListing[]
 * specifically, and there's no active-listing behaviour (favouriting,
 * bare Listing[]) it needs to stay compatible with.
 */
export default function RemovedListingsGrid({
  listings,
  emptyMessage = "No listings were removed in this time range.",
}: Props) {
  if (listings.length === 0) {
    return <p className="listings-empty">{emptyMessage}</p>;
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
            <span className="listing-card__badge listing-card__badge--removed">Removed</span>
          </div>
          <div className="listing-card__body">
            <div className="listing-card__price">{l.price}</div>
            <div className="listing-card__title">{l.title}</div>
            <div className="listing-card__attrs">
              {l.bedrooms !== null && (
                <span className="listing-card__attr">
                  <span aria-hidden="true">🛏</span> {l.bedrooms === 0 ? "Studio" : l.bedrooms}
                </span>
              )}
            </div>
            <div className="listing-card__meta">
              {l.bedroomType && <span>{l.bedroomType === "single" ? "Single" : "Double"} bed ·</span>}
              <span>{l.tenure ? TENURE_LABELS[l.tenure] : "Tenure not stated"}</span>
            </div>
            <div className="listing-card__removed-at">Removed {formatDateTime(l.removedAt)}</div>
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
