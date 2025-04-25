const { createClient } = require("@supabase/supabase-js");
const { Pinecone } = require("@pinecone-database/pinecone");
const OpenAI = require("openai");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");

// Load env variables since we're in a script
dotenv.config();

async function main() {
  // Initialize Supabase client with service role key to bypass RLS
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Initialize OpenAI client
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Initialize Pinecone client
  const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY,
  });
  const index = pc.index("unlinked");

  async function embedTexts(texts) {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  }

  async function processProfiles() {
    try {
      let page = 1;
      const pageSize = 1000;
      const batchSize = 50;
      let hasMore = true;

      while (hasMore) {
        // Get profiles with pagination
        const { data: profiles, error: fetchError } = await supabase
          .from("profiles")
          .select("id, headline")
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (fetchError) {
          throw fetchError;
        }

        console.log(`Found ${profiles?.length || 0} profiles on page ${page}`);

        // If we got less than pageSize results, we've reached the end
        if (!profiles || profiles.length < pageSize) {
          hasMore = false;
        }

        // Process profiles in batches
        for (let i = 0; i < (profiles?.length || 0); i += batchSize) {
          const batch = profiles?.slice(i, i + batchSize) || [];
          const validProfiles = batch.filter((profile) => profile.headline);

          if (validProfiles.length === 0) continue;

          try {
            console.log(`Processing batch of ${validProfiles.length} profiles`);
            const headlines = validProfiles.map((profile) => profile.headline);
            const embeddings = await embedTexts(headlines);

            // Prepare batch upsert data
            const upsertData = validProfiles.map((profile, index) => ({
              id: uuidv4(),
              values: embeddings[index],
              metadata: {
                headline: profile.headline,
                profileId: profile.id,
              },
            }));

            // Store all embeddings in Pinecone
            await index.upsert(upsertData);

            console.log(
              `Successfully processed batch of ${validProfiles.length} profiles`
            );
          } catch (error) {
            console.error(`Error processing batch:`, error);
          }

          // Add a small delay between batches
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        page++;
      }

      console.log("Finished processing all profiles");
    } catch (error) {
      console.error("Error in processProfiles:", error);
    }
  }

  // Run the process
  await processProfiles();
}

// Start the script
main().catch(console.error);
