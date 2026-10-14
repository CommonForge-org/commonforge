import { useEffect, useState } from 'react';
import { staticFile, useDelayRender } from 'remotion';
import { parseCast, type Cast } from './asciinema';

/** Fetches and parses cast files under `public/`, holding the render until they load. */
export function useCasts(paths: readonly string[]): Array<Cast | null> {
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const key = paths.join('\n');
  const [casts, setCasts] = useState<Array<Cast | null>>(() => paths.map(() => null));
  const [handle] = useState(() => delayRender(`Loading casts: ${key}`));

  useEffect(() => {
    Promise.all(
      paths.map(async (path) => {
        const response = await fetch(staticFile(path));
        if (!response.ok) throw new Error(`Cannot load cast ${path}: HTTP ${response.status}`);
        return parseCast(await response.text());
      }),
    )
      .then((loaded) => {
        setCasts(loaded);
        continueRender(handle);
      })
      .catch((error: unknown) => cancelRender(error));
    // `key` captures the paths' content; the array identity may change every render.
  }, [key, handle]);

  return casts;
}
