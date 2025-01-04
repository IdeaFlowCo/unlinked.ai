'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

function extractSlugFromLinkedInUrl(url: string | undefined | null): string | null {
    if (!url) return null
    try {
        const parsed = new URL(url)
        const segments = parsed.pathname.split('/').filter(Boolean)
        // Basic assumption: a profile URL looks like https://www.linkedin.com/in/slug
        if (segments.length >= 2 && segments[0] === 'in') {
            return segments[1]
        }
        return null
    } catch {
        return null
    }
}

export async function login(formData: FormData) {
    const supabase = await createClient()

    const { error } = await supabase.auth.signInWithPassword({
        email: formData.get('email') as string,
        password: formData.get('password') as string,
    })

    if (error) {
        redirect('/error')
    }

    redirect('/profiles')
}

export async function signup(formData: FormData) {
    const supabase = await createClient()

    const firstName = formData.get('firstName') as string
    const lastName = formData.get('lastName') as string
    const email = formData.get('email') as string
    const password = formData.get('password') as string
    const linkedInUrl = formData.get('linkedInUrl') as string

    const linkedInSlug = extractSlugFromLinkedInUrl(linkedInUrl)

    // Sign up with Supabase Auth, including user metadata
    const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                first_name: firstName,
                last_name: lastName,
                linkedin_slug: linkedInSlug
            }
        }
    })

    // If auth error, redirect or handle as appropriate
    if (error) {
        return redirect(`/auth/signup?error=${encodeURIComponent(error.message)}`)
    }

    // If signUp was successful, proceed to onboarding
    return redirect('/onboarding')
}

export async function signInWithGoogle() {
    const supabase = await createClient()

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`
        }
    })

    if (error) {
        return redirect('/error')
    }

    if (data.url) {
        return redirect(data.url)
    }

    // Create profile if this is first sign in
    const session = await supabase.auth.getSession()
    if (session.data.session?.user) {
        const { data: profile } = await supabase
            .from('profiles')
            .select('user_id')
            .eq('user_id', session.data.session.user.id)
            .single()

        if (!profile) {
            const { error: profileError } = await supabase
                .from('profiles')
                .insert({
                    user_id: session.data.session.user.id,
                    first_name: '',
                    last_name: ''
                })

            if (profileError) {
                return redirect('/error')
            }

            return redirect('/onboarding');
        }
    }

    return redirect('/profiles')
}

export async function signOut() {
    const supabase = await createClient()
    await supabase.auth.signOut()
    revalidatePath('/', 'layout')
    redirect('/')
}
