import { useEffect, useState } from 'react';
import { buildHash, parseHash, rememberLocation, resolveEntryHash } from '../domain/route.js';

export { buildHash, parseHash, readLastLocation, rememberLocation, resolveEntryHash } from '../domain/route.js';

export function navigate(route) {
  const next = buildHash(route);
  if (window.location.hash !== next) window.location.hash = next;
}

/** 订阅 hashchange；进入 `#/` 时恢复到上次位置。 */
export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const sync = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', sync);
    if (!window.location.hash || window.location.hash === '#/') {
      window.location.replace(resolveEntryHash());
      sync();
    }
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => {
    rememberLocation(route);
  }, [route]);
  return route;
}
