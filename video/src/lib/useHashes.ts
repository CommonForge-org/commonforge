import { useEffect, useState } from 'react';
import { staticFile, useDelayRender } from 'remotion';
import { parseHashes, type Hashes } from '../data';

/** What a scene shows when media.json names no hashes file: unmistakably not a real hash. */
export const NO_HASHES: Hashes = { blocked: { hash: 'PLACEHOLDER-BLOCKED' }, fixed: { hash: 'PLACEHOLDER-FIXED' } };

/** Loads media.json's `hashes` file (`hashes.json` from `pnpm capture`), holding the render until it loads. */
export function useHashes(path: string | undefined): Hashes | null {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const [hashes, setHashes] = useState<Hashes | null>(path ? null : NO_HASHES);
  const [handle] = useState(() => (path ? delayRender(`Loading hashes: ${path}`) : null));

  useEffect(() => {
    if (!path || handle === null) return;
    fetch(staticFile(path))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Cannot load ${path}: HTTP ${response.status}`);
        setHashes(parseHashes(await response.json(), path));
        continueRender(handle);
      })
      .catch((error: unknown) => cancelRender(error));
  }, [path, handle]);

  return hashes;
}
