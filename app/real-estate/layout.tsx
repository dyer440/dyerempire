// app/real-estate/layout.tsx
// The signed-in site is read-only. Bookkeeping happens through the bot API
// (Claude and GrokBot); the only input here is the note box.
import SiteFrame from '../_site/SiteFrame'

export default function RealEstateLayout({ children }: { children: React.ReactNode }) {
  return <SiteFrame>{children}</SiteFrame>
}
