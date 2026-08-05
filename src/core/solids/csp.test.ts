import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/** The prebuilt OpenCascade Embind layer generates typed wrappers at runtime. */
const html = readFileSync(join(__dirname, '../../../index.html'), 'utf8');
const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
const directive = (name: string) => policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(name)) ?? '';

describe('the policy the exact solid engine needs', () => {
  it('has a policy at all', () => {
    expect(policy, 'no CSP in index.html').not.toBe('');
  });

  it('allows the generated OpenCascade bindings to create typed wrappers', () => {
    expect(directive('script-src')).toContain("'unsafe-eval'");
  });

  it('allows the WASM itself to be compiled', () => {
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
  });

  it('still refuses everything it refused before', () => {
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('frame-src')).toBe("frame-src 'none'");
  });
});
