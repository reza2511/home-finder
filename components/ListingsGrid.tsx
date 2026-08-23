import type { Listing, TenureValue } from "@/lib/types";
import { PLACEHOLDER_IMAGE_DATA_URI } from "@/lib/placeholderImage";
import { favouriteKey } from "@/lib/favouritesClient";
import FavouriteHeart from "./FavouriteHeart";

const TENURE_LABELS: Record<TenureValue, string> = {
  share_of_freehold: "Share of freehold",
  leasehold: "Leasehold",
  freehold: "Freehold",
  shared_ownership: "Shared ownership",
};

/** Compact icon + number row for a card's structured attributes — bedrooms,
 * bathrooms, parking, floor. Each is shown only when the listing actually
 * has a real value for it (`bedrooms` is always present-or-null;
 * bathrooms/parking/floor may also be absent entirely on older rows) — a
 * missing one is left out of the row completely, never shown as 0 or
 * guessed. Renders nothing at all when not one of the four is known. */
function ListingAttrs({ listing }: { listing: Listing }) {
  const attrs: { key: string; icon: string; label: string; value: string }[] = [];

  if (listing.bedrooms !== null) {
    attrs.push({
      key: "bed",
      icon: "🛏",
      label: "Bedrooms",
      value: listing.bedrooms === 0 ? "Studio" : String(listing.bedrooms),
    });
  }
  if (listing.bathrooms != null) {
    attrs.push({ key: "bath", icon: "🛁", label: "Bathrooms", value: String(listing.bathrooms) });
  }
  if (listing.parking != null) {
    attrs.push({ key: "parking", icon: "🚗", label: "Parking", value: String(listing.parking) });
  }
  if (listing.floor != null) {
    // "G" for ground floor is a standard, unambiguous UK convention — not a
    // guess, same spirit as bedrooms:0 already rendering as "Studio" above.
    attrs.push({ key: "floor", icon: "🏢", label: "Floor", value: listing.floor === 0 ? "G" : String(listing.floor) });
  }

  if (attrs.length === 0) return null;

  return (
    <div className="listing-card__attrs">
      {attrs.map((a) => (
        <span key={a.key} className="listing-card__attr" title={a.label}>
          <span aria-hidden="true">{a.icon}</span> {a.value}
        </span>
      ))}
    </div>
  );
}

interface Props {
  listings: Listing[];
  /** Set of `sourceId::externalId` keys currently favourited, or null/
   * undefined to hide the heart icon entirely — logged-out visitors never
   * get a `favouriteKeys` set from AppShell, so the whole heart affordance
   * (not just the toggle action) is simply absent for them. */
  favouriteKeys?: Set<string> | null;
  onToggleFavourite?: (listing: Listing) => void;
  emptyMessage?: string;
}

export default function ListingsGrid({
  listings,
  favouriteKeys,
  onToggleFavourite,
  emptyMessage = "No homes match your filters. Try widening your search or clearing filters.",
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
            {l.isNewBuild && <span className="listing-card__badge">New build</span>}
            {favouriteKeys && onToggleFavourite && (
              <FavouriteHeart
                favourited={favouriteKeys.has(favouriteKey(l.sourceId, l.externalId))}
                onToggle={() => onToggleFavourite(l)}
              />
            )}
          </div>
          <div className="listing-card__body">
            <div className="listing-card__price">{l.price}</div>
            <div className="listing-card__title">{l.title}</div>
            <ListingAttrs listing={l} />
            <div className="listing-card__meta">
              {/* Bedroom count itself now lives in the icon attrs row above
                  — this line is left for the details that row has no room
                  for: single/double per-room type and tenure. */}
              {l.bedroomType && (
                <span>{l.bedroomType === "single" ? "Single" : "Double"} bed ·</span>
              )}
              <span>{l.tenure ? TENURE_LABELS[l.tenure] : "Tenure not stated"}</span>
            </div>
            {l.nearestStation && (
              <div className="listing-card__station">
                <span aria-hidden="true">🚉</span> {l.nearestStation.name} station · {l.nearestStation.distanceMiles} mi
              </div>
            )}
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
