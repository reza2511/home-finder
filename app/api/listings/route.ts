import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { Listing } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ListingDbRow {
  sourceId: string;
  sourceName: string | null;
  externalId: string;
  title: string;
  price: string;
  priceValue: number;
  url: string;
  images: string;
  mainImage: string | null;
  bedrooms: number;
  bedroomType: Listing["bedroomType"];
  tenure: Listing["tenure"];
  isNewBuild: number;
  postcode: string | null;
  area: string | null;
}

// Aggregated feed of currently-active listings across every source, for the
// main page grid. Not part of the status monitor feature, but gives the app
// something to show behind it.
export async function GET() {
  const rows = db
    .prepare(
      `SELECT l.sourceId, s.sourceName, l.externalId, l.title, l.price, l.priceValue, l.url,
              l.images, l.mainImage, l.bedrooms, l.bedroomType, l.tenure, l.isNewBuild,
              l.postcode, l.area
       FROM listings l
       LEFT JOIN sync_status s ON s.sourceId = l.sourceId
       WHERE l.active = 1
       ORDER BY l.lastSeenAt DESC
       LIMIT 200`
    )
    .all() as unknown as ListingDbRow[];

  const listings: Listing[] = rows.map((r) => ({
    sourceId: r.sourceId,
    sourceName: r.sourceName ?? r.sourceId,
    externalId: r.externalId,
    title: r.title,
    price: r.price,
    priceValue: r.priceValue,
    url: r.url,
    images: r.images ? (JSON.parse(r.images) as string[]) : [],
    mainImage: r.mainImage,
    bedrooms: r.bedrooms,
    bedroomType: r.bedroomType,
    tenure: r.tenure,
    isNewBuild: !!r.isNewBuild,
    postcode: r.postcode ?? "",
    area: r.area ?? "",
  }));

  return NextResponse.json({ listings });
}
