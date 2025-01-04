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
import { createClient as createSupabaseClient } from "npm:@supabase/supabase-js@2";
import Papa from "npm:papaparse@5.3.2";

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

// Create the Supabase client (using service_role in an Edge Function is safe)
const supabase = createSupabaseClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

/**
 * Upsert the Profile row (the non-shadow user's own profile) from Profile.csv.
 * Uses the existing "profile_id" from the uploads table.
 */
async function processProfileCsv(profileId: string, csvText: string) {
    const parsed = Papa.parse<string[]>(csvText, { header: true });
    if (parsed.data && Array.isArray(parsed.data) && parsed.data.length > 0) {
        const row = parsed.data[0];

        try {
            // Upsert the current profile using the primary key (id = profileId).
            // "onConflict" is set to "id" so that future inserts with the same PK will update.
            const { error } = await supabase
                .from("profiles")
                .upsert(
                    {
                        id: profileId,
                        first_name: row["First Name"] || null,
                        last_name: row["Last Name"] || null,
                        headline: row["Headline"] || null,
                        summary: row["Summary"] || null,
                        industry: row["Industry"] || null
                    },
                    {
                        onConflict: "id"
                    }
                );

        } catch (err) {
            console.error("Exception updating user profile from Profile.csv:", err);
        }
    }
}

/**
 * Upsert Education.csv rows for the profile.
 *  1) Upsert or create an institution record (by name).
 *  2) Insert a row into "education" linking that institution to this profile.
 */
async function processEducationCsv(profileId: string, csvText: string) {
    const parsed = Papa.parse<string[]>(csvText, { header: true });
    if (parsed.data && Array.isArray(parsed.data)) {
        for (const row of parsed.data) {
            if (!row["School Name"]) continue;
            const schoolName = row["School Name"].trim();
            const degreeName = row["Degree Name"]?.trim() || null;
            let startedOn = row["Start Date"]?.trim() || null;
            let finishedOn = row["End Date"]?.trim() || null;

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
                // Upsert the institution first
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
                if (!institutionId) continue;

                // Insert the education record
                const { error: eduError } = await supabase
                    .from("education")
                    .insert({
                        profile_id: profileId,
                        institution_id: institutionId,
                        degree_name: degreeName,
                        started_on: startedOn,
                        finished_on: finishedOn
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
 * Upsert Positions.csv rows for the profile.
 */
async function processPositionsCsv(profileId: string, csvText: string) {
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
                // Upsert the company by name
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
                if (!companyId) continue;

                // Insert the position record
                const { error: posError } = await supabase
                    .from("positions")
                    .insert({
                        profile_id: profileId,
                        company_id: companyId,
                        title,
                        description,
                        started_on: startedOn,
                        finished_on: finishedOn
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
 * Upsert Skills.csv rows for the profile.
 */
async function processSkillsCsv(profileId: string, csvText: string) {
    const parsed = Papa.parse<string[]>(csvText, { header: true });
    if (parsed.data && Array.isArray(parsed.data)) {
        for (const row of parsed.data) {
            const skillName = row["Name"]?.trim();
            if (!skillName) continue;

            try {
                const { error } = await supabase
                    .from("skills")
                    .insert({
                        profile_id: profileId,
                        name: skillName
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
 * Process Connections.csv rows for this profile in a more efficient, bulk-oriented manner.
 */
async function processConnectionsCsv(profileId: string, csvText: string) {
    // 1) Clean up CSV text (skip "Notes:" lines).
    const csvLines = csvText.split("\n");
    const actualCsvText = csvLines.slice(2).join("\n");

    // 2) Parse CSV data.
    const parsed = Papa.parse<string[]>(actualCsvText, {
        header: true,
        skipEmptyLines: true
    });

    console.log("Parsed connections data:", {
        rowCount: parsed.data?.length,
        hasData: !!parsed.data && Array.isArray(parsed.data),
        errors: parsed.errors
    });

    if (!parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) {
        return;
    }

    // 3) Filter out empty rows and prepare a typed array of connections to process
    const allConnections = parsed.data
        .map((row) => {
            const firstName = row["First Name"]?.trim() || null;
            const lastName = row["Last Name"]?.trim() || null;
            const linkedInUrl = row["URL"]?.trim() || null;
            const company = row["Company"]?.trim() || null;
            const position = row["Position"]?.trim() || null;

            if (!firstName && !lastName && !linkedInUrl) return null;

            let connectionSlug: string | null = null;
            if (linkedInUrl) {
                connectionSlug = extractSlugFromUrl(linkedInUrl);
            }

            return {
                firstName,
                lastName,
                slug: connectionSlug,
                company,
                position
            };
        })
        .filter(Boolean) as {
            firstName: string | null;
            lastName: string | null;
            slug: string | null;
            company: string | null;
            position: string | null;
        }[];

    if (allConnections.length === 0) {
        return;
    }

    // 4) Collect all unique slugs
    const slugToRowData: Record<
        string,
        { firstName: string | null; lastName: string | null; company: string | null; position: string | null }[]
    > = {};
    for (const conn of allConnections) {
        if (conn.slug) {
            if (!slugToRowData[conn.slug]) {
                slugToRowData[conn.slug] = [];
            }
            slugToRowData[conn.slug].push({
                firstName: conn.firstName,
                lastName: conn.lastName,
                company: conn.company,
                position: conn.position
            });
        }
    }
    const allSlugs = Object.keys(slugToRowData).filter(Boolean);

    // 5) Fetch existing shadow profiles (or normal profiles) in a single query
    let existingProfiles: { id: string; linkedin_slug: string; user_id: string | null }[] = [];
    if (allSlugs.length > 0) {
        const { data: fetchedProfiles, error: fetchError } = await supabase
            .from("profiles")
            .select("id, linkedin_slug, user_id")
            .in("linkedin_slug", allSlugs);

        if (fetchError) {
            console.error("Error fetching existing profiles by slug:", fetchError);
        } else if (fetchedProfiles) {
            existingProfiles = fetchedProfiles;
        }
    }

    // Build a map for slug => { id: string, isShadow: boolean }
    const slugToExistingProfile = new Map<string, { id: string; isShadow: boolean }>();
    for (const p of existingProfiles) {
        slugToExistingProfile.set(p.linkedin_slug, {
            id: p.id,
            isShadow: p.user_id === null
        });
    }

    // 6) Separate new slugs from existing slugs
    //    Also gather shadow-profiles that may need to be updated
    const newSlugRows: {
        slug: string;
        firstName: string | null;
        lastName: string | null;
        headline: string | null;
    }[] = [];
    const shadowUpdates: { id: string; firstName: string | null; lastName: string | null; headline: string | null }[] =
        [];

    for (const slug of allSlugs) {
        const existing = slugToExistingProfile.get(slug);
        if (existing) {
            // If it's a shadow profile, we can optionally update best-guess fields
            if (existing.isShadow) {
                const rowData = slugToRowData[slug][0];
                const headline =
                    rowData.company && rowData.position ? `${rowData.position} at ${rowData.company}` : null;
                shadowUpdates.push({
                    id: existing.id,
                    firstName: rowData.firstName,
                    lastName: rowData.lastName,
                    headline
                });
            }
            // If the profile is NOT shadow (user_id is not null), we do nothing for creation
        } else {
            // We only need to create a new shadow profile if no profile (shadow or user-linked) exists for that slug
            const rowData = slugToRowData[slug][0];
            const headline =
                rowData.company && rowData.position ? `${rowData.position} at ${rowData.company}` : null;
            newSlugRows.push({
                slug,
                firstName: rowData.firstName,
                lastName: rowData.lastName,
                headline
            });
        }
    }

    // 7) Update shadow profiles in chunks
    const updateBatchSize = 100;
    for (let i = 0; i < shadowUpdates.length; i += updateBatchSize) {
        const batch = shadowUpdates.slice(i, i + updateBatchSize);
        // Update each shadow profile individually or via Promise.all
        await Promise.all(
            batch.map(async (update) => {
                const { error } = await supabase
                    .from("profiles")
                    .update({
                        first_name: update.firstName || undefined,
                        last_name: update.lastName || undefined,
                        headline: update.headline || undefined
                    })
                    .eq("id", update.id);
                if (error) {
                    console.error("Error updating shadow profile:", update.id, error);
                }
            })
        );
    }

    // 8) Bulk-insert NEW shadow profiles in chunks, ignoring duplicates to avoid
    //    collisions with existing non-shadow profiles.
    let newProfilesMap = new Map<string, string>(); // slug => newly created profileId
    if (newSlugRows.length > 0) {
        const insertBatchSize = 500;
        for (let i = 0; i < newSlugRows.length; i += insertBatchSize) {
            const batch = newSlugRows.slice(i, i + insertBatchSize).map((item) => ({
                id: crypto.randomUUID(),
                user_id: null,
                first_name: item.firstName,
                last_name: item.lastName,
                linkedin_slug: item.slug,
                headline: item.headline
            }));

            // Insert in bulk, ignoring duplicates if they already exist
            const { error: insertError } = await supabase
                .from("profiles")
                .upsert(batch, {
                    onConflict: "linkedin_slug",
                    ignoreDuplicates: true
                });

            if (insertError) {
                console.error("Error creating new shadow profiles:", insertError);
                continue;
            }

            // After upsert, refetch any slugs we attempted to insert
            const slugsInBatch = batch.map((item) => item.linkedin_slug);
            const { data: insertedOrExisting, error: fetchAfterInsertErr } = await supabase
                .from("profiles")
                .select("id, linkedin_slug")
                .in("linkedin_slug", slugsInBatch);

            if (fetchAfterInsertErr) {
                console.error("Error fetching profiles after insert:", fetchAfterInsertErr);
                continue;
            }
            if (insertedOrExisting && Array.isArray(insertedOrExisting)) {
                for (const rec of insertedOrExisting) {
                    if (rec.linkedin_slug) {
                        newProfilesMap.set(rec.linkedin_slug, rec.id);
                    }
                }
            }
        }
    }

    // 9) Merge new profile IDs into existing slug map
    for (const [slug, profileId] of newProfilesMap.entries()) {
        slugToExistingProfile.set(slug, { id: profileId, isShadow: true });
    }

    // 10) Build the final list of (profile_id_a, profile_id_b) for connections
    //     Then do a bulk upsert on “connections”
    const connectionRecords: { profile_id_a: string; profile_id_b: string }[] = [];
    for (const conn of allConnections) {
        let connProfileId: string | null = null;
        if (conn.slug) {
            const found = slugToExistingProfile.get(conn.slug);
            if (found) {
                connProfileId = found.id;
            }
        }
        if (!connProfileId) continue;

        // Sort the pair to satisfy the CHECK (profile_id_a < profile_id_b)
        const sorted = [profileId, connProfileId].sort();
        connectionRecords.push({ profile_id_a: sorted[0], profile_id_b: sorted[1] });
    }

    // 11) Upsert connections in chunks
    const connBatchSize = 500;
    for (let i = 0; i < connectionRecords.length; i += connBatchSize) {
        const batch = connectionRecords.slice(i, i + connBatchSize);
        const { error: connUpsertErr } = await supabase
            .from("connections")
            .upsert(batch, { onConflict: "profile_id_a,profile_id_b" });
        if (connUpsertErr) {
            console.error("Error bulk-upserting connections:", connUpsertErr);
        }
    }
}

/**
 * Orchestrates the file parsing and DB updates for a single "uploads" record.
 */
async function handleNewUpload(upload: {
    profile_id: string;
    file_name: string;
    file_path: string;
}) {
    console.log(`Processing file "${upload.file_name}" for profile_id "${upload.profile_id}"…`);

    // Download the CSV from Storage
    const { data: downloadedFile, error: downloadErr } = await supabase.storage
        .from("linkedin")
        .download(upload.file_path);

    if (downloadErr || !downloadedFile) {
        console.error(`Unable to download file "${upload.file_path}":`, downloadErr);
        return;
    }

    const csvText = await downloadedFile.text();
    const profileId = upload.profile_id;

    // Dispatch to the correct processor
    switch (upload.file_name) {
        case "Profile.csv":
            await processProfileCsv(profileId, csvText);
            break;
        case "Education.csv":
            await processEducationCsv(profileId, csvText);
            break;
        case "Positions.csv":
            await processPositionsCsv(profileId, csvText);
            break;
        case "Skills.csv":
            await processSkillsCsv(profileId, csvText);
            break;
        case "Connections.csv":
            await processConnectionsCsv(profileId, csvText);
            break;
        default:
            console.log(`File "${upload.file_name}" is not recognized for special processing; skipping.`);
            break;
    }
}

/**
 * Main request handler via Deno.serve
 * Expects a JSON payload from Supabase webhooks, with shape:
 *  {
 *    "type": "INSERT" | "UPDATE" | "DELETE",
 *    "table": "uploads",
 *    "schema": "public",
 *    "record": { ...the new uploads row... },
 *    "old_record": null
 *  }
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
