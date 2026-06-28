// middleware.ts  (REWRITE — homepage now public; allowlist unchanged otherwise)
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'

const ADMIN_EMAIL = 'david.dyer.24@gmail.com'

// '/' is exact — only the homepage is public, not everything under it.
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/not-authorized',
])

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return

  const { userId, redirectToSignIn, sessionClaims } = await auth()
  if (!userId) return redirectToSignIn()

  const email = sessionClaims?.email as string | undefined
  if (!email) return NextResponse.redirect(new URL('/not-authorized', req.url))

  if (email === ADMIN_EMAIL) return

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const result = await sql`SELECT email FROM allowed_users WHERE email = ${email} LIMIT 1`
    if (result.length === 0) {
      return NextResponse.redirect(new URL('/not-authorized', req.url))
    }
  } catch (error) {
    console.error('DB allowlist check failed:', error)
    return NextResponse.redirect(new URL('/not-authorized', req.url))
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
