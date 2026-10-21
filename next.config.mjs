/** @type {import('next').NextConfig} */
const nextConfig = {
  // Database drivers must run only on the server and must not be bundled.
  serverExternalPackages: ["pg", "neo4j-driver", "ioredis", "bcryptjs"],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
