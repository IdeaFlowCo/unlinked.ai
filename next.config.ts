import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serve the real callback before additive canonical-client registration.
  // Uploads remain on the direct runtime; this is not a Vercel archive proxy.
  async rewrites() {
    return [{
      source: "/auth/callback/ideaflow",
      destination: "https://private.unlinked.ai/auth/callback/ideaflow",
    }];
  },
};

export default nextConfig;
