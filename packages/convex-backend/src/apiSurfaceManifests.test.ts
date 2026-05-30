import { describe, expect, it } from 'vitest';
import {
  API_SURFACE_MANIFEST_RETENTION,
  selectManifestIdsToPrune,
} from '../convex/apiSurfaceManifests.js';

describe('ApiSurfaceManifest retention', () => {
  it('keeps the newest 20 manifests for a Product and prunes the rest', () => {
    const manifests = Array.from({ length: 23 }, (_, index) => ({
      _id: `manifest-${index + 1}`,
      builtAt: 10_000 - index,
    }));

    expect(selectManifestIdsToPrune(manifests)).toEqual([
      'manifest-21',
      'manifest-22',
      'manifest-23',
    ]);
    expect(API_SURFACE_MANIFEST_RETENTION).toBe(20);
  });
});
