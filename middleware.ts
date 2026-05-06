import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const ALLOWED_EMAILS = [
  'david.dyer.24@gmail.com', // replace with your actual allowed emails
]

const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)'])

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return

  const { userId, redirectToSignIn } = await auth()

  if (!userId) return redirectToSignIn()

  // Check allowlist
  const { sessionClaims } = await auth()
  const email = sessionClaims?.email as string | undefined

  if (email && !ALLOWED_EMAILS.includes(email)) {
    const url = new URL('/not-authorized', req.url)
    return NextResponse.redirect(url)
  }
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
