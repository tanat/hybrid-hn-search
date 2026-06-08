import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native modules that must not be bundled by the server build: the reranker's
  // ONNX runtime and the better-sqlite3 binding used by the local query log.
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node', 'better-sqlite3'],
};

export default nextConfig;
