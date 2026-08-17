// Self-contained placeholder (no network dependency) shown on listing cards
// that have no photos. Matches the app's neutral surface/muted palette.
const PLACEHOLDER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#eceef2"/>
  <g transform="translate(400,280)" fill="none" stroke="#9aa2b1" stroke-width="10" stroke-linejoin="round" stroke-linecap="round">
    <path d="M-120,10 L0,-100 L120,10" />
    <rect x="-90" y="10" width="180" height="110" />
    <rect x="-20" y="55" width="40" height="65" fill="#9aa2b1" stroke="none"/>
  </g>
  <text x="400" y="460" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#9aa2b1">No photo available</text>
</svg>
`.trim();

export const PLACEHOLDER_IMAGE_DATA_URI = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;
