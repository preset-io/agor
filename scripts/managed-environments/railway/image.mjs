import { PreviewError } from './api.mjs';

// Public, trusted-main dependency image only. Never forward operator credentials
// or follow a registry-supplied authentication URL to another host.
export async function previewBase(request = fetch) {
  try {
    const options = { redirect: 'error', signal: AbortSignal.timeout(30_000) };
    const auth = await request(
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:preset/agor:pull',
      options
    );
    if (!auth.ok) throw new Error();
    const { token } = await auth.json();
    if (typeof token !== 'string' || !token) throw new Error();
    const response = await request(
      'https://registry-1.docker.io/v2/preset/agor/manifests/preview-runtime-main',
      {
        ...options,
        method: 'HEAD',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept:
            'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
        },
      }
    );
    // The first main publication may not have happened yet. Do not disguise
    // rate-limit/transport errors as a cache miss and incur a cold build.
    // Hub also returns 401 for repositories not yet public/created.
    if (response.status === 404 || response.status === 401) {
      console.error(
        'Preview base is not publicly available yet; Railway will build the dependency base from branch source.'
      );
      return 'runtime-build';
    }
    const digest = response.headers.get('docker-content-digest');
    if (!response.ok || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error();
    return `preset/agor@${digest}`;
  } catch {
    throw new PreviewError(
      'Cannot resolve the trusted preview base from Docker Hub. No provisioning attempted; retry when the registry is available.'
    );
  }
}
