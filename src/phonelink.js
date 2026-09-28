// How the phone racket's messages reach the game, read from the WebRTC stats of the connection's chosen candidate
// pair. Pure (no DOM, no network), so test/phonelink.test.mjs can check it in Node.
//   'Wi-Fi direct': phone and PC talk straight to each other on the same network (the fast case).
//   'internet':     direct, but across the internet (the phone on mobile data, or another network).
//   'TURN relay':   through a relay server on the internet, the slowest route.
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|f[cd][0-9a-f]{2}:|fe80:|::1$)/i;

export function routeName(local, remote) {
  const lt = local && local.type, rt = remote && remote.type, ra = String((remote && remote.address) || '');
  if (!lt || !rt) return '';
  if (lt === 'relay' || rt === 'relay') return 'TURN relay';
  // A phone's own address usually shows up hidden (an .local name) or as a private one: same network.
  const lan = rt === 'host' || !ra || /\.local$/i.test(ra) || PRIVATE.test(ra);
  return lt === 'host' && lan ? 'Wi-Fi direct' : 'internet';
}

// The candidate pair in use, from an RTCStatsReport (or any Map of stats): { local, remote, rtt (ms) }, or null.
export function selectedPair(stats) {
  let pair = null;
  stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId && stats.get(s.selectedCandidatePairId)) pair = stats.get(s.selectedCandidatePairId); });
  if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected || (s.nominated && !pair))) pair = s; });   // Firefox marks it 'selected'
  if (!pair) return null;
  const cand = (id) => { const s = stats.get(id); return s ? { type: s.candidateType, address: s.address || s.ip || '' } : null; };
  return { local: cand(pair.localCandidateId), remote: cand(pair.remoteCandidateId), rtt: Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : 0 };
}
