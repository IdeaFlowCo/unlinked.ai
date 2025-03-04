'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { headers } from 'next/headers'

export async function login(formData: FormData) {
    const supabase = await createClient()

    const { error } = await supabase.auth.signInWithPassword({
        email: formData.get('email') as string,
        password: formData.get('password') as string,
    })

    if (error) {
        redirect(`/auth/login?error=${encodeURIComponent(error.message)}`)
    }

    redirect('/profiles')
}

export async function signup(formData: FormData) {
    const supabase = await createClient()

    const fullName = (formData.get('fullName') as string)?.trim()

    // Validate full name
    if (!fullName) {
        return redirect(`/auth/signup?error=${encodeURIComponent('Full name is required')}`)
    }
    if (fullName.length < 2) {
        return redirect(`/auth/signup?error=${encodeURIComponent('Name must be at least 2 characters')}`)
    }
    if (!fullName.includes(' ')) {
        return redirect(`/auth/signup?error=${encodeURIComponent('Please enter both first and last name')}`)
    }
    if (fullName.length > 100) {
        return redirect(`/auth/signup?error=${encodeURIComponent('Name is too long')}`)
    }
    if (!/^[a-zA-Z\s\-']+$/.test(fullName)) {
        return redirect(`/auth/signup?error=${encodeURIComponent('Name contains invalid characters')}`)
    }

    const { error } = await supabase.auth.signUp({
        email: formData.get('email') as string,
        password: formData.get('password') as string,
        options: {
            data: {
                full_name: fullName,
            },
        },
    })

    if (error) {
        return redirect(`/auth/signup?error=${encodeURIComponent(error.message)}`)
    }

    return redirect('/onboarding')
}

export async function signInWithGoogle() {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
            queryParams: {
                access_type: 'offline',
                prompt: 'consent',
            },
        },
    })

    if (error) {
        const currentPath = new URL((await headers()).get('referer') || '').pathname
        const redirectPath = currentPath.startsWith('/auth/signup') ? '/auth/signup' : '/auth/login'
        redirect(`${redirectPath}?error=${encodeURIComponent(error.message)}`)
    }

    if (data.url) {
        redirect(data.url)
    }
}

export async function signOut() {
    const supabase = await createClient()
    await supabase.auth.signOut()
    revalidatePath('/', 'layout')
    redirect('/')
}

export async function resetPassword(formData: FormData) {
    const supabase = await createClient()
    const email = formData.get('email') as string

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/confirm?next=/auth/reset-password`,
    })

    if (error) {
        return redirect(`/auth/login?error=${encodeURIComponent(error.message)}`)
    }

    return redirect('/auth/login?message=Check your email for password reset instructions')
}
