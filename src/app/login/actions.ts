'use server'

import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

export async function loginOrSignup(formData: FormData) {
    console.log('Starting loginOrSignup')
    const supabase = await createClient()

    const data = {
        email: formData.get('email') as string,
        password: formData.get('password') as string,
    }

    console.log('Attempting sign in:', data.email)
    
    // Try to sign in first
    const { error: signInError } = await supabase.auth.signInWithPassword(data)

    // If sign in succeeds, redirect to profiles
    if (!signInError) {
        console.log('Sign in successful, redirecting to profiles')
        return redirect('/profiles')
    }

    // If sign in fails for any reason, attempt signup
    console.log('Sign in failed, attempting signup:', signInError.message)
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp(data)

    if (signUpError) {
        console.error('Sign up error:', signUpError.message)
        return redirect('/error')
    }

    if (!signUpData.user) {
        console.error('Sign up failed: No user data')
        return redirect('/error')
    }
    
    // After successful signup, redirect to profiles
    console.log('Signup successful, redirecting to profiles')
    revalidatePath('/profiles', 'layout')
    return redirect('/profiles')
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
        redirect('/error')
    }

    if (data.url) {
        redirect(data.url)
    }

    revalidatePath('/', 'layout')
    redirect('/')
}

export async function signOut() {
    const supabase = await createClient()
    await supabase.auth.signOut()
    revalidatePath('/', 'layout')
    redirect('/login')
}
