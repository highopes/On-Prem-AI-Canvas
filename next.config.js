/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  allowedDevOrigins: [
    "csco-ai-canvas.aibus88.com",
    "*.aibus88.com",
    "localhost",
    "127.0.0.1",
    "192.168.160.183",
  ],
};

module.exports = nextConfig;

