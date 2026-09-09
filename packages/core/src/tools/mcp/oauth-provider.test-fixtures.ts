/**
 * Public metadata subset from safe GETs on 2026-09-09; Dropbox GETs were rate
 * limited, so its metadata is explicitly modeled, not a captured response.
 * Registration outcomes are SYNTHETIC provider-shaped cases, never live DCR
 * receipts. The supplied jose-3-test evidence did not preserve rejection
 * status/body. No fixture may be cited as proving that missing live detail.
 * New Relic/Canva model a redirect echo that cannot prove upstream approval;
 * Figma models that even valid OAuth wire shapes do not grant catalog access.
 */
export const OAUTH_PROVIDER_FIXTURES = [
  {
    label: 'Vercel',
    name: 'com.vercel/vercel-mcp',
    url: 'https://mcp.vercel.com',
    metadata: {
      issuer: 'https://vercel.com',
      authorization_endpoint: 'https://vercel.com/oauth/authorize',
      token_endpoint: 'https://api.vercel.com/login/oauth/token',
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: 'https://api.vercel.com/login/oauth/register',
    },
    modeledRegistration: 'rejected',
  },
  {
    label: 'Asana',
    name: 'com.asana/mcp',
    url: 'https://mcp.asana.com/sse',
    metadata: {
      issuer: 'https://mcp.asana.com',
      authorization_endpoint: 'https://mcp.asana.com/authorize',
      token_endpoint: 'https://mcp.asana.com/token',
      registration_endpoint: 'https://mcp.asana.com/register',
      code_challenge_methods_supported: ['plain', 'S256'],
    },
    modeledRegistration: 'rejected',
  },
  {
    label: 'Dropbox',
    name: 'com.dropbox/mcp',
    url: 'https://mcp.dropbox.com/mcp',
    metadata: {
      issuer: 'https://mcp.dropbox.com',
      authorization_endpoint: 'https://mcp.dropbox.com/authorize',
      token_endpoint: 'https://mcp.dropbox.com/token',
      registration_endpoint: 'https://mcp.dropbox.com/register',
      code_challenge_methods_supported: ['S256'],
    },
    modeledRegistration: 'rejected',
  },
  {
    label: 'Intercom',
    name: 'com.intercom/mcp',
    url: 'https://mcp.intercom.com/mcp',
    metadata: {
      issuer: 'https://mcp.intercom.com',
      authorization_endpoint: 'https://mcp.intercom.com/authorize',
      token_endpoint: 'https://mcp.intercom.com/token',
      registration_endpoint: 'https://mcp.intercom.com/register',
      code_challenge_methods_supported: ['S256'],
    },
    modeledRegistration: 'rejected',
  },
  {
    label: 'Square',
    name: 'com.squareup/mcp',
    url: 'https://mcp.squareup.com/mcp',
    metadata: {
      issuer: 'https://mcp.squareup.com',
      authorization_endpoint: 'https://mcp.squareup.com/authorize',
      token_endpoint: 'https://mcp.squareup.com/token',
      registration_endpoint: 'https://mcp.squareup.com/register',
      code_challenge_methods_supported: ['plain', 'S256'],
    },
    modeledRegistration: 'rejected',
  },
  {
    label: 'New Relic',
    name: 'com.newrelic/mcp-server',
    url: 'https://mcp.newrelic.com/mcp',
    metadata: {
      issuer: 'https://oauth2.service.newrelic.com',
      authorization_endpoint: 'https://oauth2.service.newrelic.com/oauth2/auth',
      registration_endpoint: 'https://dcr.service.newrelic.com/register',
      token_endpoint: 'https://oauth2.service.newrelic.com/oauth2/token',
      code_challenge_methods_supported: ['plain', 'S256'],
    },
    modeledRegistration: 'redirect_echo',
  },
  {
    label: 'Canva',
    name: 'com.canva/mcp',
    url: 'https://mcp.canva.com/mcp',
    metadata: {
      issuer: 'https://mcp.canva.com',
      authorization_endpoint: 'https://mcp.canva.com/authorize',
      token_endpoint: 'https://mcp.canva.com/token',
      registration_endpoint: 'https://mcp.canva.com/register',
      code_challenge_methods_supported: ['plain', 'S256'],
    },
    modeledRegistration: 'redirect_echo',
  },
  {
    label: 'Figma',
    name: 'com.figma.mcp/mcp',
    url: 'https://mcp.figma.com/mcp',
    metadata: {
      issuer: 'https://api.figma.com',
      authorization_endpoint: 'https://www.figma.com/oauth/mcp',
      token_endpoint: 'https://api.figma.com/v1/oauth/token',
      registration_endpoint: 'https://api.figma.com/v1/oauth/mcp/register',
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    },
    modeledRegistration: 'redirect_echo',
  },
] as const;
