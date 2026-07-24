import { createServerClient, parse, serialize } from '@supabase/auth-helpers-nextjs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function proxy(req: NextRequest) {
  const res = NextResponse.next()

  // Guard: NEXT_PUBLIC_SUPABASE_ANON_KEY may not be configured in all environments
  // (API routes only need SERVICE_ROLE_KEY). Skip session refresh rather than crash.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) return res

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get: (key) => parse(req.headers.get('cookie') ?? '')[key],
      set: (key, value, options) => {
        res.headers.append('Set-Cookie', serialize(key, value, options))
      },
      remove: (key, options) => {
        res.headers.append('Set-Cookie', serialize(key, '', { ...options, maxAge: 0 }))
      },
    },
  })
  await supabase.auth.getSession()
  return res
}

// Next.js 16: config (not proxyConfig) is the canonical export name per docs
export const config = {
  matcher: ['/nexus', '/nexus/:path*']
}
