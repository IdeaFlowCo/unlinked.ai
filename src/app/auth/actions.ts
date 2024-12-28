'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

export async function login(formData: FormData) {
    const supabase = await createClient()

    // type-casting here for convenience
    // in practice, you should validate your inputs
    const data = {
        email: formData.get('email') as string,
        password: formData.get('password') as string,
    }

    const { error } = await supabase.auth.signInWithPassword(data)

    if (error) {
        redirect('/error')
    }

    revalidatePath('/', 'layout')
    redirect('/')
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
        redirect('/error')
    }

    revalidatePath('/', 'layout')
    redirect('/')
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
            .select('id')
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
        }
    }

    revalidatePath('/profiles', 'layout')
    return redirect('/profiles')
}

export async function signOut() {
    const supabase = await createClient()
    await supabase.auth.signOut()
    revalidatePath('/', 'layout')
    redirect('/auth/login')
}
