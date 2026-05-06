import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    yaml: 'src/yaml.ts',
    jwt: 'src/jwt.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: false,
  // Keep FeathersJS + socket.io as runtime dependencies (not bundled)
  external: [
    '@feathersjs/authentication-client',
    '@feathersjs/feathers',
    '@feathersjs/rest-client',
    '@feathersjs/socketio-client',
    'socket.io-client',
  ],
});
