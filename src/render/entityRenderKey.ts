import type { Entity } from '../core/entities/types';

/**
 * Entity data is currently mutable, so render invalidation cannot rely on
 * object identity. Keep this boundary isolated until the document store gains
 * explicit immutable revisions.
 */
export function entityRenderKey(entity: Entity): string {
  return JSON.stringify(entity);
}
