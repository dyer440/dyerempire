// app/admin/layout.tsx
import SiteFrame from '../_site/SiteFrame'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <SiteFrame>{children}</SiteFrame>
}
