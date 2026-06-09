const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Watch the shared package so Metro picks up changes
config.watchFolders = [path.resolve(__dirname, '../../packages/shared')];

// Allow .wasm files to be resolved
config.resolver.assetExts.push('wasm');

// Required for SharedArrayBuffer used by expo-sqlite WASM
config.server = config.server || {};
config.server.enhanceMiddleware = (middleware) => {
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    middleware(req, res, next);
  };
};

module.exports = config;
