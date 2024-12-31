/**
 * A Supabase Edge Function that listens for INSERT events on the "uploads" table.
 * Whenever a user uploads their LinkedIn data, this function:
 *   1. Fetches the newly uploaded CSV from the "linkedin" storage bucket.
 *   2. Parses the file (optimistically, continuing if certain rows fail).
 *   3. Upserts data into profiles/positions/education/skills tables as needed.
 *   4. Creates "shadow" profiles for newly discovered connections (if they don’t already have a profile).
 *   5. Associates the uploading user’s profile with those connections in the "connections" table.
 *
 * It’s important to note that the webhook payload from Supabase has this shape:
 *   {
 *     "type": "INSERT" | "UPDATE" | "DELETE",
 *     "table": "uploads",
 *     "schema": "public",
 *     "record": { ...the new row data... },
 *     "old_record": null | { ...the old row data... }
 *   }
 *
 * This code expects the "record" field to contain the new row from the "uploads" table.
 */
import { createClient as createSupabaseClient } from "supabase-js";
import Papa from "papaparse";

/**
 * Utility to extract a LinkedIn slug from a URL.
 */
function extractSlugFromUrl(url?: string | null): string | null {
    if (!url) return null;
    try {
        const path = new URL(url).pathname; // e.g. "/in/john-doe-12345"
        const segments = path.split("/").filter(Boolean); // e.g. ["in", "john-doe-12345"]
        if (segments.length >= 2 && segments[0] === "in") {
            return segments[1]; // e.g. "john-doe-12345"
        }
        return null;
    } catch {
        return null;
    }
}

// Create your Supabase client (using service_role in an Edge Function is safe)
const supabase = createSupabaseClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

/**
 * Upsert the user's own Profile from "Profile.csv".
 */
async function processProfileCsv(userId: string, csvText: string) {
    const parsed = Papa.parse<string[]>(csvText, { header: true });
    if (parsed.data && Array.isArray(parsed.data) && parsed.data.length > 0) {
        const row = parsed.data[0];
        const linkedInUrl = row["Profile URL"]?.trim() || null;
        const linkedInSlug = linkedInUrl ? extractSlugFromUrl(linkedInUrl) : null;

        try {
            // First, check if there's an existing shadow profile with this LinkedIn slug
            if (linkedInSlug) {
                const { data: existingShadow } = await supabase
                    .from("profiles")
                    .select("id")
                    .eq("linkedin_slug", linkedInSlug)
                    .eq("is_shadow", true)
                    .maybeSingle();

                if (existingShadow) {
                    // If found, delete the shadow profile since we're about to claim this identity
                    await supabase
                        .from("profiles")
                        .delete()
                        .eq("id", existingShadow.id);
                }
            }

            // Now update the user's real profile
            const { error } = await supabase
                .from("profiles")
                .update({
                    first_name: row["First Name"] || null,
                    last_name: row["Last Name"] || null,
                    headline: row["Headline"] || null,
                    summary: row["Summary"] || null,
                    industry: row["Industry"] || null,
                    linkedin_slug: linkedInSlug,
                    is_shadow: false, // Ensure it's marked as a real profile
                })
                .eq("id", userId);

            if (error) {
                console.error("Error updating user profile from Profile.csv:", error);
            }
        } catch (err) {
            console.error("Exception updating user profile from Profile.csv:", err);
        }
    }
}

/**
 * Upsert Education.csv rows for the user.
 *  1) Upsert an institution record (by name).
 *  2) Insert a row into "education" linking that institution to the user’s profile.
 */
async function processEducationCsv(userId: string, csvText: string) {
    const parsed = Papa.parse<string[]>(csvText, { header: true });
    if (parsed.data && Array.isArray(parsed.data)) {
        for (const row of parsed.data) {
            if (!row["School Name"]) continue;
            const schoolName = row["School Name"].trim();
            const degreeName = row["Degree Name"]?.trim() || null;
            let startedOn = row["Start Date"]?.trim() || null;
            let finishedOn = row["End Date"]?.trim() || null;

            // Attempt to parse dates
            if (startedOn) {
                try {
                    startedOn = new Date(startedOn).toISOString().slice(0, 10);
                } catch {
                    startedOn = null;
                }
            }
            if (finishedOn) {
                try {
                    finishedOn = new Date(finishedOn).toISOString().slice(0, 10);
                } catch {
                    finishedOn = null;
                }
            }

            try {
                // 1) Upsert institution
                const { data: instData, error: instError } = await supabase
                    .from("institutions")
                    .upsert({ name: schoolName })
                    .select("id")
                    .single();

                if (instError) {
                    console.error(`Institution upsert failed for "${schoolName}":`, instError);
                    continue;
                }
                const institutionId = instData?.id;

                // 2) Insert an education row
                const { error: eduError } = await supabase.from("education").insert({
                    profile_id: userId,
                    institution_id: institutionId,
                    degree_name: degreeName,
                    started_on: startedOn,
                    finished_on: finishedOn,
                });
                if (eduError && !eduError.message.includes("duplicate key")) {
                    console.error("Error inserting education row:", eduError);
                }
            } catch (err) {
                console.error("Exception inserting education row:", err);
            }
        }
    }
}

/**
 * Upsert Positions.csv rows for the user.
 */
async function processPositionsCsv(userId: string, csvText: string) {
    const parsed = Papa.parse<string[]>(csvText, { header: true });
    if (parsed.data && Array.isArray(parsed.data)) {
        for (const row of parsed.data) {
            if (!row["Company Name"]) continue;
            const companyName = row["Company Name"].trim();
            const title = row["Title"]?.trim() || null;
            const description = row["Description"]?.trim() || null;
            let startedOn = row["Started On"]?.trim() || null;
            let finishedOn = row["Finished On"]?.trim() || null;

            if (startedOn) {
                try {
                    startedOn = new Date(startedOn).toISOString().slice(0, 10);
                } catch {
                    startedOn = null;
                }
            }
            if (finishedOn) {
                try {
                    finishedOn = new Date(finishedOn).toISOString().slice(0, 10);
                } catch {
                    finishedOn = null;
                }
            }

            try {
                // 1) Upsert the company
                const { data: compData, error: compError } = await supabase
                    .from("companies")
                    .upsert({ name: companyName })
                    .select("id")
                    .single();

                if (compError) {
                    console.error(`Company upsert failed for "${companyName}":`, compError);
                    continue;
                }
                const companyId = compData?.id;

                // 2) Insert position
                const { error: posError } = await supabase.from("positions").insert({
                    profile_id: userId,
                    company_id: companyId,
                    title,
                    description,
                    started_on: startedOn,
                    finished_on: finishedOn,
                });
                if (posError && !posError.message.includes("duplicate key")) {
                    console.error("Error inserting position row:", posError);
                }
            } catch (err) {
                console.error("Exception inserting position row:", err);
            }
        }
    }
}

/**
 * Upsert Skills.csv rows for the user.
 */
async function processSkillsCsv(userId: string, csvText: string) {
    const parsed = Papa.parse<string[]>(csvText, { header: true });
    if (parsed.data && Array.isArray(parsed.data)) {
        for (const row of parsed.data) {
            const skillName = row["Name"]?.trim();
            if (!skillName) continue;

            try {
                const { error } = await supabase.from("skills").insert({
                    profile_id: userId,
                    name: skillName,
                });
                if (error && !error.message.includes("duplicate key")) {
                    console.error("Error inserting skill row:", error);
                }
            } catch (err) {
                console.error("Exception inserting skill row:", err);
            }
        }
    }
}

/**
 * Process Connections.csv rows for the user.
 */
async function processConnectionsCsv(userId: string, csvText: string) {
    // Skip the "Notes:" lines at the top of the LinkedIn export
    const csvLines = csvText.split('\n');
    const actualCsvText = csvLines.slice(2).join('\n');  // Skip first two lines

    const { data: ownerProfile, error: ownerErr } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .single();

    console.log("Owner profile check:", { userId, found: !!ownerProfile, error: ownerErr });

    if (ownerErr || !ownerProfile) {
        console.error(`Cannot find user profile for userId "${userId}". Skipping connections.`);
        return;
    }

    const parsed = Papa.parse<string[]>(actualCsvText, {
        header: true,
        skipEmptyLines: true
    });

    console.log("Parsed connections data:", {
        rowCount: parsed.data?.length,
        hasData: !!parsed.data && Array.isArray(parsed.data),
        errors: parsed.errors
    });

    if (parsed.data && Array.isArray(parsed.data)) {
        for (const row of parsed.data) {
            if (!row["First Name"] && !row["Last Name"] && !row["URL"]) {
                continue;
            }

            // Log each connection attempt
            console.log("Processing connection:", {
                firstName: row["First Name"]?.trim() || null,
                lastName: row["Last Name"]?.trim() || null,
                url: row["URL"]?.trim() || null
            });

            const firstName = row["First Name"]?.trim() || null;
            const lastName = row["Last Name"]?.trim() || null;
            const linkedInUrl = row["URL"]?.trim() || null;

            let connectionSlug: string | null = null;
            if (linkedInUrl) connectionSlug = extractSlugFromUrl(linkedInUrl);

            try {
                let connectionProfileId: string | null = null;

                // If there's a LinkedIn slug, look for an existing profile with that slug
                if (connectionSlug) {
                    const { data: existingProfile, error: existErr } = await supabase
                        .from("profiles")
                        .select("id, is_shadow")
                        .eq("linkedin_slug", connectionSlug)
                        .maybeSingle();

                    if (!existErr && existingProfile) {
                        connectionProfileId = existingProfile.id;
                    }
                }

                // If no matching profile found, create a "shadow" profile
                if (!connectionProfileId) {
                    const newId = crypto.randomUUID();
                    const company = row["Company"]?.trim() || null;
                    const position = row["Position"]?.trim() || null;
                    const headline = company && position ? `${position} at ${company}` : null;

                    const { data: newProfile, error: newProfErr } = await supabase
                        .from("profiles")
                        .insert({
                            id: newId,
                            first_name: firstName,
                            last_name: lastName,
                            linkedin_slug: connectionSlug || null,
                            headline: headline,
                            is_shadow: true,
                        })
                        .select("id")
                        .single();

                    if (newProfErr) {
                        console.error("Error creating shadow profile:", newProfErr);
                        continue;
                    }
                    connectionProfileId = newProfile?.id;
                }

                // Insert a row in "connections", ensuring (profile_id_a < profile_id_b)
                if (connectionProfileId) {
                    const sorted = [ownerProfile.id, connectionProfileId].sort();
                    const [profile_id_a, profile_id_b] = sorted;

                    // Check if connection already exists
                    const { data: existingConn, error: connCheckErr } = await supabase
                        .from("connections")
                        .select("id")
                        .eq("profile_id_a", profile_id_a)
                        .eq("profile_id_b", profile_id_b)
                        .maybeSingle();

                    if (connCheckErr) {
                        console.error("Error checking for existing connection:", connCheckErr);
                        continue;
                    }
                    // Insert if none
                    if (!existingConn) {
                        const { error: connInsertErr } = await supabase.from("connections").insert({
                            profile_id_a,
                            profile_id_b,
                        });
                        if (connInsertErr) {
                            console.error("Error inserting new connection:", connInsertErr);
                        }
                    }
                }
            } catch (err) {
                console.error("Exception creating connection:", err);
            }
        }
    }
}

/**
 * Orchestrates the file parsing and DB updates for a single "uploads" record.
 */
async function handleNewUpload(upload: {
    file_name: string;
    file_path: string;
    user_id: string;
}) {
    console.log(`Processing file "${upload.file_name}" for user_id "${upload.user_id}"…`);

    // Download CSV from the "linkedin" storage bucket
    const { data: downloadedFile, error: downloadErr } = await supabase.storage
        .from("linkedin")
        .download(upload.file_path);

    if (downloadErr || !downloadedFile) {
        console.error(`Unable to download file "${upload.file_path}":`, downloadErr);
        return;
    }

    const csvText = await downloadedFile.text();

    // Dispatch to the correct processor
    switch (upload.file_name) {
        case "Profile.csv":
            await processProfileCsv(upload.user_id, csvText);
            break;
        case "Education.csv":
            await processEducationCsv(upload.user_id, csvText);
            break;
        case "Positions.csv":
            await processPositionsCsv(upload.user_id, csvText);
            break;
        case "Skills.csv":
            await processSkillsCsv(upload.user_id, csvText);
            break;
        case "Connections.csv":
            await processConnectionsCsv(upload.user_id, csvText);
            break;
        default:
            console.log(`File "${upload.file_name}" is not recognized for special processing; skipping.`);
            break;
    }
}

/**
 * Main request handler via Deno.serve.
 * Expects a JSON payload from Supabase webhooks, something like:
 * {
 *   "type": "INSERT",
 *   "table": "uploads",
 *   "schema": "public",
 *   "record": { ...the new row... },
 *   "old_record": null
 * }
 */
Deno.serve(async (req) => {
    if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
    }

    try {
        const payload = await req.json();
        const newUpload = payload?.record;
        if (!newUpload) {
            return new Response('No "record" found in webhook payload.', { status: 400 });
        }

        await handleNewUpload(newUpload);
        return new Response("OK", { status: 200 });
    } catch (error) {
        console.error("Error in process-uploads Edge Function:", error);
        return new Response("Internal Server Error", { status: 500 });
    }
});
