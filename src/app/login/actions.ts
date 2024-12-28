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

    console.log('Attempting sign in for:', data.email)
    
    // First try to sign in
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword(data)

    // If sign in fails with invalid credentials, try to sign up
    if (signInError && signInError.status === 400) {
        console.log('Sign in failed, attempting signup:', signInError.message)
        const { data: signUpData, error: signUpError } = await supabase.auth.signUp(data)

        if (signUpError) {
            console.error('Sign up error:', signUpError.message)
            return redirect('/error')
        }

        if (signUpData.user) {
            console.log('Signup successful:', signUpData)
            // After successful signup, try to sign in immediately
            const { error: autoSignInError } = await supabase.auth.signInWithPassword(data)
            
            if (autoSignInError) {
                console.error('Auto sign in after signup failed:', autoSignInError.message)
                return redirect('/error')
            }
        }
    } else if (signInError) {
        // Handle other sign in errors
        console.error('Sign in error:', signInError.message)
        return redirect('/error')
    }

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
