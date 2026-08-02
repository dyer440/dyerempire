// app/real-estate/layout.tsx
// Section layout for the entire real-estate area. Renders the global nav above
// every route under /real-estate/* (properties, entity ledgers, importer, rent
// roll, southside) — no per-page changes required. Nested layouts (e.g. the
// per-property layout with PropertyNav) render inside this one, giving nav +
// subnav for free.
import RealEstateNav from './_components/RealEstateNav'

export default function RealEstateLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <RealEstateNav />
      {children}
    </>
  )
}
