import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The Content Security Policy and the solid engine are coupled, and nothing in
 * the code says so. Tightening the policy — which reads like an unambiguously
 * good idea — silently breaks every boolean, extrusion and sweep in the app,
 * and only in the app: the tests run in Node, where there is no policy to
 * violate, so they all still pass. It took a bug report to find it once.
 */
const html = readFileSync(join(__dirname, '../../../index.html'), 'utf8');
const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
const directive = (name: string) => policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(name)) ?? '';

describe('the policy the solid engine needs', () => {
  it('has a policy at all', () => {
    expect(policy, 'no CSP in index.html').not.toBe('');
  });

  it("allows manifold's bindings to build their invokers", () => {
    // embind writes `new Function(args, body)` from the type signatures it
    // registers. Take this away and EXTRUDE fails on its first call.
    expect(directive('script-src')).toContain("'unsafe-eval'");
  });

  it('allows the WASM itself to be compiled', () => {
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
  });

  it('still refuses everything it refused before', () => {
    // The loosening is meant to be exactly one word wide.
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('frame-src')).toBe("frame-src 'none'");
  });
});
