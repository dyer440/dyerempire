// app/media/layout.tsx
import SiteFrame from '../_site/SiteFrame'

export default function MediaLayout({ children }: { children: React.ReactNode }) {
  return <SiteFrame>{children}</SiteFrame>
}
