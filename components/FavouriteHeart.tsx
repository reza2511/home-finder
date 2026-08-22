"use client";

interface Props {
  favourited: boolean;
  onToggle: () => void;
  busy?: boolean;
}

// Sits on top of a listing card that's itself a whole clickable <a> — the
// stopPropagation/preventDefault pair keeps a click here from also
// navigating to the external listing.
export default function FavouriteHeart({ favourited, onToggle, busy }: Props) {
  return (
    <button
      type="button"
      className={`favourite-heart${favourited ? " favourite-heart--active" : ""}`}
      aria-pressed={favourited}
      aria-label={favourited ? "Remove from favourites" : "Add to favourites"}
      disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
    >
      {favourited ? "♥" : "♡"}
    </button>
  );
}
