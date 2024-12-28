'use server'

import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

export async function loginOrSignup(formData: FormData) {
    console.log('Starting loginOrSignup')
    console.log('Form data:', {
        email: formData.get('email'),
        password: formData.get('password')?.toString().slice(0, 1) + '***'
    })
    const supabase = await createClient()

    const data = {
        email: formData.get('email') as string,
        password: formData.get('password') as string,
    }

    console.log('Checking if user exists:', data.email)
    
    // First try to sign in
    console.log('Attempting sign in')
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword(data)

    if (!signInError && signInData.user) {
        console.log('Sign in successful')
        
        // Verify profile exists
        const { data: profile } = await supabase
            .from('profiles')
            .select('id')
            .eq('user_id', signInData.user.id)
            .single()

        if (!profile) {
            console.log('Creating missing profile for existing user:', signInData.user.id)
            const { error: profileError } = await supabase
                .from('profiles')
                .insert({
                    user_id: signInData.user.id,
                    first_name: '',
                    last_name: ''
                })

            if (profileError) {
                console.error('Profile creation error:', profileError.message)
                return redirect('/error')
            }
        }

        console.log('Profile verified, redirecting to profiles')
        return redirect('/profiles')
    }

    // If sign in failed, try signup
    console.log('Sign in failed, attempting signup')
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp(data)

    if (signUpError) {
        console.error('Sign up error:', signUpError.message)
        return redirect('/login?error=' + encodeURIComponent(signUpError.message))
    }

    if (!signUpData.user) {
        console.error('Sign up failed: No user data')
        return redirect('/error')
    }
    
    // After successful signup, create profile
    console.log('Creating profile for new user:', signUpData.user.id)
    const { error: profileError } = await supabase
        .from('profiles')
        .insert({
            user_id: signUpData.user.id,
            first_name: '',  // These will be populated during onboarding
            last_name: ''
        })

    if (profileError) {
        console.error('Profile creation error:', profileError.message)
        return redirect('/login?error=' + encodeURIComponent(profileError.message))
    }

    console.log('Profile created successfully, redirecting to profiles')
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
