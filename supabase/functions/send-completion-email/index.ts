// @ts-ignore: Deno types
import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
// @ts-ignore: Deno types
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface EmailRequestBody {
  email: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      // @ts-ignore: Deno env
      Deno.env.get('SUPABASE_URL') ?? '',
      // @ts-ignore: Deno env
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { email } = (await req.json()) as EmailRequestBody

    if (!email) {
      return new Response(
        JSON.stringify({ error: 'Email is required' }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400 
        }
      )
    }

    // Send email using Supabase's email service
    const { error } = await supabaseClient.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: {
        provider: 'email',
      },
      user_metadata: {
        email_notifications: true,
      },
    })

    if (error) throw error

    // Send the actual email
    await supabaseClient.from('emails').insert({
      to: email,
      subject: 'Your LinkedIn Data is Ready!',
      html: `
        <h2>Your LinkedIn Data Has Been Processed</h2>
        <p>Good news! We've finished processing your LinkedIn data export.</p>
        <p>You can now explore your connections and profile by visiting your profile page.</p>
        <p><a href="${
          // @ts-ignore: Deno env
          Deno.env.get('SITE_URL') ?? 'https://unlinked.ai'
        }/profile">View Your Profile</a></p>
      `,
      status: 'pending'
    })

    return new Response(
      JSON.stringify({ message: 'Email sent successfully' }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    )
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    )
  }
})
