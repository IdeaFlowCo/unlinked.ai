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

    const { error } = await supabase.auth.signUp({
        email: formData.get('email') as string,
        password: formData.get('password') as string,
        options: {
            data: {
                first_name: formData.get('firstName') as string,
                last_name: formData.get('lastName') as string,
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

    const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
    })

    if (error) {
        const currentPath = new URL((await headers()).get('referer') || '').pathname
        const redirectPath = currentPath.startsWith('/auth/signup') ? '/auth/signup' : '/auth/login'
        return redirect(`${redirectPath}?error=${encodeURIComponent(error.message)}`)
    }

    const { data: { user } } = await supabase.auth.getUser()

    const { data: onboardingState } = await supabase
        .from('onboarding_state')
        .select('completed_at')
        .eq('user_id', user?.id)
        .single()

    return redirect(onboardingState?.completed_at ? '/profiles' : '/onboarding')
}

export async function signOut() {
    const supabase = await createClient()
    await supabase.auth.signOut()
    revalidatePath('/', 'layout')
    redirect('/')
}
