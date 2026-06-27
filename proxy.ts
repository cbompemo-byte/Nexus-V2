import { createServerClient, parse, serialize } from '@supabase/auth-helpers-nextjs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function proxy(req: NextRequest) {
  const res = NextResponse.next()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (key) => parse(req.headers.get('cookie') ?? '')[key],
        set: (key, value, options) => {
          res.headers.append('Set-Cookie', serialize(key, value, options))
        },
        remove: (key, options) => {
          res.headers.append('Set-Cookie', serialize(key, '', { ...options, maxAge: 0 }))
        },
      },
    }
  )
  await supabase.auth.getSession()
  return res
}

export const proxyConfig = {
  matcher: ['/nexus', '/nexus/:path*']
}
