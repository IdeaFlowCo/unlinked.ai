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

  // Create a dummy vector of the correct dimension (3072 for text-embedding-3-large)
  const dummyVector = new Array(3072).fill(0);

  async function embedTexts(texts) {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: texts,
    });

    return response.data.map((item) => item.embedding);
  }

  async function verifyProfiles() {
    try {
      let page = 1;
      const pageSize = 1000;
      const missingProfiles = [];
      let hasMore = true;

      while (hasMore) {
        // Get profiles with pagination
        const { data: profiles, error: fetchError } = await supabase
          .from("profiles")
          .select("id, headline")
          .range((page - 1) * pageSize, page * pageSize - 1);

        if (fetchError) {
          throw fetchError;
        }

        console.log(
          `Checking ${profiles?.length || 0} profiles on page ${page}`
        );

        // If we got less than pageSize results, we've reached the end
        if (!profiles || profiles.length < pageSize) {
          hasMore = false;
        }

        // Process profiles in smaller batches to avoid overwhelming Pinecone
        const batchSize = 500;
        for (let i = 0; i < (profiles?.length || 0); i += batchSize) {
          const batch = profiles?.slice(i, i + batchSize) || [];
          const validProfiles = batch.filter((profile) => profile.headline);

          if (validProfiles.length === 0) continue;

          try {
            console.log(
              `Processing batch of ${validProfiles.length} profiles (${i + 1}-${
                i + validProfiles.length
              })`
            );

            // Query Pinecone with dummy vector but filter for this batch of profile IDs
            const queryResponse = await index.query({
              vector: dummyVector,
              filter: {
                profileId: { $in: validProfiles.map((p) => p.id) },
              },
              includeMetadata: true,
              topK: validProfiles.length, // Make sure we get all possible matches
            });

            // Create a set of profile IDs that have embeddings
            const profilesWithEmbeddings = new Set(
              queryResponse.matches.map((match) => match.metadata.profileId)
            );

            // Check which profiles are missing
            for (const profile of validProfiles) {
              if (!profilesWithEmbeddings.has(profile.id)) {
                missingProfiles.push({
                  id: profile.id,
                  headline: profile.headline,
                });
                if (profile.id === "4e813cc8-a867-473b-a743-fdce92e11951") {
                  console.log(
                    "profile.id:",
                    profile.id,
                    "profile.headline:",
                    profile.headline
                  );
                }
              }
            }
          } catch (batchError) {
            console.error("Error processing batch:", batchError);
            console.error("Batch details:", {
              batchSize: validProfiles.length,
              firstProfileId: validProfiles[0]?.id,
              lastProfileId: validProfiles[validProfiles.length - 1]?.id,
            });
          }

          // Add a small delay between batches
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        page++;
      }

      // Final report
      console.log("\n=== Verification Report ===");
      console.log(`Total missing profiles: ${missingProfiles.length}`);

      if (missingProfiles.length > 0) {
        console.log("\nEmbedding missing profiles...");

        // Process missing profiles in batches
        const embedBatchSize = 50; // Smaller batch size for embedding
        for (let i = 0; i < missingProfiles.length; i += embedBatchSize) {
          const batch = missingProfiles.slice(i, i + embedBatchSize);
          console.log(
            `Embedding batch ${i / embedBatchSize + 1} of ${Math.ceil(
              missingProfiles.length / embedBatchSize
            )}`
          );

          try {
            const headlines = batch.map((profile) => profile.headline);
            const embeddings = await embedTexts(headlines);

            // Prepare batch upsert data
            const upsertData = batch.map((profile, index) => ({
              id: uuidv4(),
              values: embeddings[index],
              metadata: {
                headline: profile.headline,
                profileId: profile.id,
              },
            }));

            // Store embeddings in Pinecone
            await index.upsert(upsertData);
            console.log(`Successfully embedded ${batch.length} profiles`);
          } catch (error) {
            console.error("Error embedding batch:", error);
            console.error("First profile in failed batch:", batch[0]);
          }

          // Add a small delay between batches
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    } catch (error) {
      console.error("Error in verifyProfiles:", error);
      if (error.response) {
        console.error("Error response:", {
          status: error.response.status,
          data: error.response.data,
        });
      }
      throw error;
    }
  }

  // Run the verification
  await verifyProfiles();
}

// Start the script
main().catch(console.error);
